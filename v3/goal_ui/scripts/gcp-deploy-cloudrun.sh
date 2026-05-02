#!/usr/bin/env bash
#
# Deploy goal_ui's functions backend to Google Cloud Run.
#
# WHY Cloud Run instead of 4 Cloud Functions Gen2:
#   - All 4 handlers share the existing Hono server in functions/server.ts
#   - One URL covers all routes (matches the SPA's path-based routing)
#   - TypeScript via `npm start` (`tsx functions/server.ts`); no per-fn
#     package.json + main fragmentation; no compile step
#   - Cloud Run buildpacks handle Node detection + scale-to-zero
#
# Run from v3/goal_ui/. Idempotent.
#
# Env vars (sane defaults; override as needed):
#   PROJECT_ID                  gcloud config default
#   REGION                      us-central1
#   RUFLO_FUNCTIONS_TOKEN       openssl rand -hex 32 (auto-generated if unset)
#   RUFLO_ALLOWED_ORIGINS       https://goal.ruv.io
#   RUFLO_RATE_LIMIT_PER_MIN    60
#   RUFLO_ANTHROPIC_SECRET_NAME ANTHROPIC_API_KEY
#   RUFLO_BRAIN_SECRET_NAME     brain-api-key       (pi.ruv.io grounding; soft)
#   RUFLO_GOOGLE_SECRET_NAME    GOOGLE_AI_API_KEY   (Vertex grounding; soft)
#   RUFLO_TOKEN_SECRET_NAME     RUFLO_FUNCTIONS_TOKEN (SPA<->API token; soft)
#   SERVICE_NAME                ruflo-research-fns
#   MIN_INSTANCES               1   (cold-start kill for public domain)

set -euo pipefail

cd "$(dirname "$0")/.." # → v3/goal_ui/

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || echo '')}"
REGION="${REGION:-us-central1}"
SECRET_NAME="${RUFLO_ANTHROPIC_SECRET_NAME:-ANTHROPIC_API_KEY}"
BRAIN_SECRET_NAME="${RUFLO_BRAIN_SECRET_NAME:-brain-api-key}"
GOOGLE_SECRET_NAME="${RUFLO_GOOGLE_SECRET_NAME:-GOOGLE_AI_API_KEY}"
TOKEN_SECRET_NAME="${RUFLO_TOKEN_SECRET_NAME:-RUFLO_FUNCTIONS_TOKEN}"
SERVICE_NAME="${SERVICE_NAME:-ruflo-research-fns}"
RUFLO_TOKEN="${RUFLO_FUNCTIONS_TOKEN:-}"
ALLOWED_ORIGINS="${RUFLO_ALLOWED_ORIGINS:-https://goal.ruv.io}"
RATE_LIMIT="${RUFLO_RATE_LIMIT_PER_MIN:-60}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: PROJECT_ID not set" >&2
  echo "Run: gcloud config set project <PROJECT_ID>" >&2
  exit 2
fi

if [[ -z "$RUFLO_TOKEN" ]]; then
  # Prefer Secret Manager — pinning the token there means the SPA bundle
  # stays cache-valid across deploys (the token is baked in at build time
  # via VITE_FUNCTIONS_PUBLIC_TOKEN). The deploy script bound the secret
  # to the Cloud Run runtime SA when this secret was created.
  if gcloud secrets describe "$TOKEN_SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "✓ Using pinned token from Secret Manager: $TOKEN_SECRET_NAME"
    RUFLO_TOKEN="$(gcloud secrets versions access latest --secret="$TOKEN_SECRET_NAME" --project="$PROJECT_ID" 2>/dev/null)"
    echo "  Token: $RUFLO_TOKEN"
  else
    echo "WARNING: RUFLO_FUNCTIONS_TOKEN not set and no '$TOKEN_SECRET_NAME' secret exists. Generating a fresh one:"
    RUFLO_TOKEN="$(openssl rand -hex 32)"
    echo "  $RUFLO_TOKEN"
    echo "  (paste this into the frontend's VITE_FUNCTIONS_PUBLIC_TOKEN, or"
    echo "   create a Secret Manager secret named '$TOKEN_SECRET_NAME' to pin it)"
  fi
fi

if ! gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: Secret Manager secret '$SECRET_NAME' not found" >&2
  echo "  Create + seed: docs/DEPLOYMENT-GCP.md §Anthropic API key" >&2
  exit 3
fi

# Discover the Cloud Run runtime SA so we can grant it secret access for
# the optional grounding secrets. PROJECT_NUMBER → default compute SA.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || echo '')"
RUNTIME_SA="${PROJECT_NUMBER:+${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"

# Build --set-secrets list. Anthropic is required; the two grounding
# secrets (brain-api-key, GOOGLE_AI_API_KEY) are SOFT — if the secret
# isn't in Secret Manager we skip its binding rather than failing the
# deploy. The handler tolerates absence (returns [] from that source).
SECRETS_BINDING="ANTHROPIC_API_KEY=${SECRET_NAME}:latest"

if gcloud secrets describe "$BRAIN_SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  SECRETS_BINDING="${SECRETS_BINDING},BRAIN_API_KEY=${BRAIN_SECRET_NAME}:latest"
  echo "✓ Binding pi.ruv.io grounding secret: $BRAIN_SECRET_NAME → BRAIN_API_KEY"
  if [[ -n "$RUNTIME_SA" ]]; then
    gcloud secrets add-iam-policy-binding "$BRAIN_SECRET_NAME" \
      --project="$PROJECT_ID" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role='roles/secretmanager.secretAccessor' \
      --quiet >/dev/null 2>&1 || true
  fi
else
  echo "  (skip) pi.ruv.io grounding secret '$BRAIN_SECRET_NAME' not found"
fi

if gcloud secrets describe "$GOOGLE_SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  SECRETS_BINDING="${SECRETS_BINDING},GOOGLE_AI_API_KEY=${GOOGLE_SECRET_NAME}:latest"
  echo "✓ Binding Google Vertex grounding secret: $GOOGLE_SECRET_NAME → GOOGLE_AI_API_KEY"
  if [[ -n "$RUNTIME_SA" ]]; then
    gcloud secrets add-iam-policy-binding "$GOOGLE_SECRET_NAME" \
      --project="$PROJECT_ID" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role='roles/secretmanager.secretAccessor' \
      --quiet >/dev/null 2>&1 || true
  fi
else
  echo "  (skip) Google grounding secret '$GOOGLE_SECRET_NAME' not found"
fi

# Env-vars file (gcloud --set-env-vars's CSV format breaks on URL lists).
ENV_FILE="$(mktemp -t ruflo-runrun-env.XXXXXX).yaml"
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<EOF_ENV
RUFLO_FUNCTIONS_TOKEN: "${RUFLO_TOKEN}"
RUFLO_ALLOWED_ORIGINS: "${ALLOWED_ORIGINS}"
RUFLO_RATE_LIMIT_PER_MIN: "${RATE_LIMIT}"
GCLOUD_PROJECT_ID: "${PROJECT_ID}"
EOF_ENV

echo "Deploying $SERVICE_NAME to $PROJECT_ID/$REGION (secret: $SECRET_NAME)"
echo ""

gcloud run deploy "$SERVICE_NAME" \
  --source=. \
  --region="$REGION" \
  --allow-unauthenticated \
  --env-vars-file="$ENV_FILE" \
  --set-secrets="$SECRETS_BINDING" \
  --memory=512Mi \
  --timeout=540 \
  --max-instances=10 \
  --min-instances="$MIN_INSTANCES" \
  --cpu-boost \
  --quiet

URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)' 2>/dev/null || echo unknown)"
echo ""
echo "✓ Service live: $URL"
echo ""
echo "Health probe:"
echo "  curl -s '$URL/'"
echo ""
echo "Frontend env:"
echo "  VITE_FUNCTIONS_BASE_URL=$URL"
echo "  VITE_FUNCTIONS_PUBLIC_TOKEN=$RUFLO_TOKEN"
