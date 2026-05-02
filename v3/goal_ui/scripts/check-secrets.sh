#!/usr/bin/env bash
#
# Pre-commit / CI gate that blocks committing API-key-shaped strings
# in tracked source or built artifacts. Per ADR-093 §S1.
#
# Patterns scanned (tightened to reduce false-positives):
#
#   sk-ant-[A-Za-z0-9_-]{20,}    Anthropic API keys
#   sk-proj-[A-Za-z0-9_-]{20,}   OpenAI project keys
#   sk-svcacct-[A-Za-z0-9_-]{20,} OpenAI service-account keys
#   sk-[A-Za-z0-9]{40,}          OpenAI legacy/user keys (40+ alnum)
#   AIza[A-Za-z0-9_-]{30,}       Google API keys
#   xoxb-[A-Za-z0-9-]{30,}       Slack bot tokens
#   ghp_[A-Za-z0-9]{30,}         GitHub personal access tokens
#   ghs_[A-Za-z0-9]{30,}         GitHub server tokens
#
# Deliberately NOT matched: bare JWT-shaped strings (`eyJhbGciOi...`).
# Supabase anon keys, OAuth bearer tokens, and many other publishable
# tokens use the same shape — different threat model from API keys
# above. If a JWT is genuinely secret (e.g. service-role), it should
# already be matched by one of the prefixed patterns or live in a
# non-VITE_ env var that doesn't reach the bundle.
#
# Also flags any environment variable definition where a `VITE_*`
# name is set to one of those patterns — the VITE_ prefix exposes
# vars to the browser bundle, so a key in such a var is an
# automatic leak.
#
# Exits 0 on clean, 1 on hit.

set -euo pipefail

cd "$(dirname "$0")/.."

# Where to look. Build artifacts land in dist/ + public/widget.{js,css}.
SCAN_DIRS=()
[[ -d src ]] && SCAN_DIRS+=(src)
[[ -d functions ]] && SCAN_DIRS+=(functions)
[[ -d tests ]] && SCAN_DIRS+=(tests)
[[ -d dist ]] && SCAN_DIRS+=(dist)
[[ -f public/widget.js ]] && SCAN_DIRS+=(public/widget.js)
[[ -f public/widget.css ]] && SCAN_DIRS+=(public/widget.css)
[[ -f index.html ]] && SCAN_DIRS+=(index.html)

if [[ ${#SCAN_DIRS[@]} -eq 0 ]]; then
  echo "check-secrets: no scan targets exist (build first?)" >&2
  exit 0
fi

# Ignore this script itself, and the example.env (which only documents)
EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=__report__
  --exclude-dir=__screenshots__
  --exclude-dir=test-results
  --exclude='check-secrets.sh'
  --exclude='example.env'
  --exclude='*.png'
  --exclude='*.webm'
  --exclude='*.zip'
  --exclude='trace.zip'
)

PATTERN='sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-svcacct-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}|AIza[A-Za-z0-9_-]{30,}|xoxb-[A-Za-z0-9-]{30,}|gh[ps]_[A-Za-z0-9]{30,}'

# Run grep (POSIX-safe, no pipefail trip on no-match)
HITS=$(grep -rEn "${EXCLUDES[@]}" -- "$PATTERN" "${SCAN_DIRS[@]}" 2>/dev/null || true)

# Specific check: any VITE_* name assigned a key-shaped value
VITE_LEAK=$(grep -rEn "${EXCLUDES[@]}" -- 'VITE_[A-Z0-9_]+\s*=\s*["'"'"']?(sk-|AIza|xoxb-|ghp_|ghs_)' "${SCAN_DIRS[@]}" 2>/dev/null || true)

if [[ -n "$HITS" || -n "$VITE_LEAK" ]]; then
  echo "❌ check-secrets: API-key-shaped strings detected." >&2
  echo "" >&2
  if [[ -n "$HITS" ]]; then
    echo "Pattern hits:" >&2
    echo "$HITS" >&2
    echo "" >&2
  fi
  if [[ -n "$VITE_LEAK" ]]; then
    echo "VITE_ leak (a Vite-exposed env var holds a key-shaped value):" >&2
    echo "$VITE_LEAK" >&2
    echo "" >&2
  fi
  echo "Fix: rotate the key, move it to a non-VITE_ server-side env var," >&2
  echo "and add the file to the gitignore if it shouldn't be tracked." >&2
  exit 1
fi

echo "✓ check-secrets: clean (scanned ${SCAN_DIRS[*]})"
