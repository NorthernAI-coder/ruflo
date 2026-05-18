/**
 * CLAUDE.md Generator
 * Generates lean, enforceable Claude Code configuration optimized for token efficiency.
 *
 * Templates: minimal | standard | full | security | performance | solo
 * All templates use imperative rules and agent comms-first coordination.
 */

import type { InitOptions, ClaudeMdTemplate } from './types.js';

// --- Section Generators ---

function behavioralRules(): string {
  return `## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use \`/src\`, \`/tests\`, \`/docs\`, \`/config\`, \`/scripts\`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- Keep files under 500 lines
- Validate input at system boundaries`;
}

function agentComms(): string {
  return `## Agent Comms — Reality-Based Coordination

**Tool-availability asymmetry:** \`SendMessage\` works **lead↔subagent** and lead↔lead, but **NOT subagent↔subagent**. Subagents spawned via the \`Agent\` tool are stateless one-shot workers — they have no inbox, cannot wait for events, and \`SendMessage\`/\`TaskUpdate\` are typically not in their tool allowlists. The \`hive-mind_*\` MCP tools provide coordination **metadata** (registry, consensus state) but do NOT grant subagents communication channels. Patterns that assume peer messaging will silently fail — agents either abort cleanly or run open-loop with stale assumptions. (See ruvnet/ruflo#2028 for the diagnosis.)

### Canonical pattern: memory-as-bus, lead-orchestrated phases

\`\`\`
Lead (the orchestrator)
  │
  ├─ spawns agent → agent reads inputs from memory keys → writes outputs to memory keys → completes
  │
  ├─ verifies outputs in memory
  │
  └─ spawns next agent with explicit input-key list in its brief
\`\`\`

All inter-agent state lives in a shared memory namespace (\`memory_store\` / \`memory_search\`). Lead-to-subagent \`SendMessage\` is fine when needed; subagent-to-subagent \`SendMessage\` is not.

### Spawning rules

- **Parallelize ONLY when work is genuinely independent** (no upstream dependency between siblings).
- **Spawn dependent agents only after the lead confirms upstream outputs are in memory.** Do NOT tell a downstream agent to "WAIT for SendMessage from X" — it has no mechanism to wait; it will abort.
- **Every subagent brief MUST include a degraded-mode paragraph** at the top: *"If your expected coordination tools (SendMessage, TaskUpdate, hive-mind_*) are missing, do NOT abort. Read these specific source files directly, write outputs to these specific memory keys, and complete your phase."*
- **Name agents** — \`name: "role"\` makes them addressable by the lead even though they cannot address each other.
- **After spawning**: STOP, tell user what's running, wait for completion notifications. No polling.

### Spawning example (memory-as-bus)

\`\`\`javascript
// Phase 1 — independent parallel work
Agent({
  prompt: "Read docs at <paths>. Write inventory JSON to memory key phase1/researcher/inventory in namespace <ns>. Degraded mode: if memory tools missing, return inventory in your final message.",
  subagent_type: "researcher", name: "researcher", run_in_background: true
})
Agent({
  prompt: "Walk the source tree. Write capability matrix to memory key phase1/coder/capability-matrix. Degraded mode: ...",
  subagent_type: "coder", name: "source-reader", run_in_background: true
})

// AFTER both Phase 1 agents complete (lead verifies via memory_search), THEN spawn Phase 2.
// Each Phase 2 agent's brief explicitly lists the Phase 1 memory keys it should read.
\`\`\`

### Patterns

| Pattern | Flow | Use When |
|---------|------|----------|
| **Sequential pipeline** | Lead → A → (verify in memory) → B → (verify) → C | Phase dependencies (audit, complex refactor) |
| **Fan-out** | Lead → A, B, C (parallel) → Lead aggregates from memory | Independent parallel work (research, multi-lens critique) |
| **Lead-as-bus** | Subagents → Lead → reroute by spawning next | Workaround when supervisor↔workers coordination needed |

### Anti-patterns (will silently fail)

- "WAIT for SendMessage from X" in a subagent prompt — no mechanism to wait
- "SendMessage findings to architect" in a subagent prompt — architect can't receive
- Spawning N dependent agents in one batch expecting them to chain via messages — they won't
- Relying on \`hive-mind_consensus\` to gather subagent votes — subagents aren't registered hive workers

### Lead-only SendMessage (still works)

\`SendMessage\` is still useful for **lead → subagent** redirects and priority changes:

\`\`\`javascript
// Lead → subagent: redirect or update priority mid-flight
SendMessage({ to: "developer", summary: "Prioritize auth", message: "Auth is blocking tester, do that first." })
// Lead → subagent: graceful shutdown
SendMessage({ to: "developer", message: { type: "shutdown_request" } })
\`\`\``;
}

function swarmConfig(options: InitOptions): string {
  return `## Swarm & Routing

### Config
- **Topology**: ${options.runtime.topology} (anti-drift)
- **Max Agents**: ${options.runtime.maxAgents}
- **Memory**: ${options.runtime.memoryBackend}
- **HNSW**: ${options.runtime.enableHNSW ? 'Enabled' : 'Disabled'}
- **Neural**: ${options.runtime.enableNeural ? 'Enabled' : 'Disabled'}

\`\`\`bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
\`\`\`

### Agent Routing

| Task | Agents | Topology |
|------|--------|----------|
| Bug Fix | researcher, coder, tester | hierarchical |
| Feature | architect, coder, tester, reviewer | hierarchical |
| Refactor | architect, coder, reviewer | hierarchical |
| Performance | perf-engineer, coder | hierarchical |
| Security | security-architect, auditor | hierarchical |

### When to Swarm
- **YES**: 3+ files, new features, cross-module refactoring, API changes, security, performance
- **NO**: single file edits, 1-2 line fixes, docs updates, config changes, questions

### 3-Tier Model Routing

| Tier | Handler | Use Cases |
|------|---------|-----------|
| 1 | Agent Booster (WASM) | Simple transforms — skip LLM, use Edit directly |
| 2 | Haiku | Simple tasks, low complexity |
| 3 | Sonnet/Opus | Architecture, security, complex reasoning |`;
}

function memoryAndLearning(): string {
  return `## Memory & Learning

### Before Any Task
\`\`\`bash
npx @claude-flow/cli@latest memory search --query "[task keywords]" --namespace patterns
npx @claude-flow/cli@latest hooks route --task "[task description]"
\`\`\`

### After Success
\`\`\`bash
npx @claude-flow/cli@latest memory store --namespace patterns --key "[name]" --value "[what worked]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true --store-results true
\`\`\`

### MCP Tools (use \`ToolSearch("keyword")\` to discover)

| Category | Key Tools |
|----------|-----------|
| **Memory** | \`memory_store\`, \`memory_search\`, \`memory_search_unified\` |
| **Bridge** | \`memory_import_claude\`, \`memory_bridge_status\` |
| **Swarm** | \`swarm_init\`, \`swarm_status\`, \`swarm_health\` |
| **Agents** | \`agent_spawn\`, \`agent_list\`, \`agent_status\` |
| **Hooks** | \`hooks_route\`, \`hooks_post-task\`, \`hooks_worker-dispatch\` |
| **Security** | \`aidefence_scan\`, \`aidefence_is_safe\`, \`aidefence_has_pii\` |
| **Hive-Mind** | \`hive-mind_init\`, \`hive-mind_consensus\`, \`hive-mind_spawn\` |

### Background Workers

| Worker | When |
|--------|------|
| \`audit\` | After security changes |
| \`optimize\` | After performance work |
| \`testgaps\` | After adding features |
| \`map\` | Every 5+ file changes |
| \`document\` | After API changes |

\`\`\`bash
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
\`\`\``;
}

function agentTypes(): string {
  return `## Agents

**Core**: \`coder\`, \`reviewer\`, \`tester\`, \`planner\`, \`researcher\`
**Architecture**: \`system-architect\`, \`backend-dev\`, \`mobile-dev\`
**Security**: \`security-architect\`, \`security-auditor\`
**Performance**: \`performance-engineer\`, \`perf-analyzer\`
**Coordination**: \`hierarchical-coordinator\`, \`mesh-coordinator\`, \`adaptive-coordinator\`
**GitHub**: \`pr-manager\`, \`code-review-swarm\`, \`issue-tracker\`, \`release-manager\`

Any string works as a custom agent type.`;
}

function cliQuickRef(): string {
  return `## CLI Quick Reference

\`\`\`bash
npx @claude-flow/cli@latest init --wizard           # Setup
npx @claude-flow/cli@latest swarm init --v3-mode     # Start swarm
npx @claude-flow/cli@latest memory search --query "" # Vector search
npx @claude-flow/cli@latest hooks route --task ""    # Route to agent
npx @claude-flow/cli@latest doctor --fix             # Diagnostics
npx @claude-flow/cli@latest security scan            # Security scan
npx @claude-flow/cli@latest performance benchmark    # Benchmarks
\`\`\`

26 commands, 140+ subcommands. Use \`--help\` on any command for details.`;
}

function setupAndBoundary(): string {
  return `## Setup

\`\`\`bash
claude mcp add claude-flow -- npx -y @claude-flow/cli@latest
npx @claude-flow/cli@latest daemon start
npx @claude-flow/cli@latest doctor --fix
\`\`\`

**Agent tool** handles execution (agents, files, code, git). **MCP tools** handle coordination (swarm, memory, hooks). **CLI** is the same via Bash.`;
}

function buildAndTest(): string {
  return `## Build & Test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing

\`\`\`bash
npm run build && npm test
\`\`\``;
}

function securitySection(): string {
  return `## Security

- NEVER hardcode secrets in source — use environment variables
- Always validate input at boundaries (Zod schemas)
- Always sanitize file paths (prevent traversal)
- Always use parameterized queries (prevent injection)

\`\`\`bash
npx @claude-flow/cli@latest security scan --depth full
npx @claude-flow/cli@latest security audit --report
\`\`\`

Agents: \`security-architect\` (threat modeling), \`security-auditor\` (vulnerability detection)`;
}

function performanceSection(): string {
  return `## Performance

- Always benchmark before AND after optimization
- Always profile before optimizing — never guess bottlenecks
- Use HNSW/DiskANN for vector search, Int8 quantization for memory reduction

\`\`\`bash
npx @claude-flow/cli@latest performance benchmark --suite all
npx @claude-flow/cli@latest performance profile --target "[component]"
\`\`\`

Agents: \`performance-engineer\` (profiling), \`perf-analyzer\` (bottleneck detection)`;
}

function hooksRef(): string {
  return `## Hooks

| Hook | Purpose |
|------|---------|
| \`pre-task\` / \`post-task\` | Task lifecycle + learning |
| \`pre-edit\` / \`post-edit\` | File editing + neural training |
| \`session-start\` / \`session-end\` | Session persistence |
| \`route\` | Route to optimal agent |
| \`intelligence\` | Pattern learning (SONA) |
| \`worker\` | Background worker dispatch |

\`\`\`bash
npx @claude-flow/cli@latest hooks pre-task --description "[task]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true
npx @claude-flow/cli@latest hooks session-start --session-id "[id]"
npx @claude-flow/cli@latest hooks route --task "[task]"
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
\`\`\``;
}

function intelligenceSystem(): string {
  return `## Intelligence (SONA + HNSW)

Pipeline: **RETRIEVE** (vector search) → **JUDGE** (success/failure) → **DISTILL** (extract patterns) → **CONSOLIDATE** (persist)

- **ONNX Embeddings**: all-MiniLM-L6-v2, 384-dim
- **HNSW/DiskANN**: 150x-12,500x faster search
- **SONA**: Sub-millisecond pattern adaptation
- **Claude Bridge**: Auto-imports \`~/.claude/projects/*/memory/*.md\` into AgentDB`;
}

function federationRef(): string {
  return `## Federation

Cross-installation agent collaboration with zero-trust security.

\`\`\`bash
npx @claude-flow/cli@latest federation init
npx @claude-flow/cli@latest federation join wss://peer:8443
npx @claude-flow/cli@latest federation send --to peer --type task-request --message "..."
npx @claude-flow/cli@latest federation status
\`\`\`

- 5-tier trust: UNTRUSTED → VERIFIED → ATTESTED → TRUSTED → PRIVILEGED
- PII pipeline: 14 types auto-stripped before data leaves your node
- mTLS + ed25519 handshake, HMAC-signed envelopes
- Compliance: HIPAA, SOC2, GDPR audit modes`;
}

function envVars(): string {
  return `## Environment

\`\`\`bash
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_LOG_LEVEL=info
CLAUDE_FLOW_MEMORY_BACKEND=hybrid
CLAUDE_FLOW_MEMORY_PATH=./data/memory
\`\`\``;
}

// --- Template Composers ---

const TEMPLATE_SECTIONS: Record<ClaudeMdTemplate, Array<(opts: InitOptions) => string>> = {
  minimal: [
    behavioralRules,
    (_opts) => agentComms(),
    swarmConfig,
    (_opts) => buildAndTest(),
    (_opts) => cliQuickRef(),
    (_opts) => setupAndBoundary(),
  ],
  standard: [
    behavioralRules,
    (_opts) => agentComms(),
    swarmConfig,
    (_opts) => memoryAndLearning(),
    (_opts) => agentTypes(),
    (_opts) => buildAndTest(),
    (_opts) => cliQuickRef(),
    (_opts) => setupAndBoundary(),
  ],
  full: [
    behavioralRules,
    (_opts) => agentComms(),
    swarmConfig,
    (_opts) => memoryAndLearning(),
    (_opts) => agentTypes(),
    (_opts) => hooksRef(),
    (_opts) => intelligenceSystem(),
    (_opts) => federationRef(),
    (_opts) => buildAndTest(),
    (_opts) => envVars(),
    (_opts) => cliQuickRef(),
    (_opts) => setupAndBoundary(),
  ],
  security: [
    behavioralRules,
    (_opts) => agentComms(),
    swarmConfig,
    (_opts) => securitySection(),
    (_opts) => memoryAndLearning(),
    (_opts) => agentTypes(),
    (_opts) => buildAndTest(),
    (_opts) => cliQuickRef(),
    (_opts) => setupAndBoundary(),
  ],
  performance: [
    behavioralRules,
    (_opts) => agentComms(),
    swarmConfig,
    (_opts) => performanceSection(),
    (_opts) => memoryAndLearning(),
    (_opts) => agentTypes(),
    (_opts) => intelligenceSystem(),
    (_opts) => buildAndTest(),
    (_opts) => cliQuickRef(),
    (_opts) => setupAndBoundary(),
  ],
  solo: [
    behavioralRules,
    (_opts) => agentComms(),
    (_opts) => memoryAndLearning(),
    (_opts) => buildAndTest(),
    (_opts) => cliQuickRef(),
    (_opts) => setupAndBoundary(),
  ],
};

// --- Public API ---

export function generateClaudeMd(options: InitOptions, template?: ClaudeMdTemplate): string {
  const tmpl = template ?? options.runtime.claudeMdTemplate ?? 'standard';
  const sections = TEMPLATE_SECTIONS[tmpl] ?? TEMPLATE_SECTIONS.standard;

  const header = `# Ruflo — Claude Code Configuration\n`;
  const body = sections.map(fn => fn(options)).join('\n\n');

  return `${header}\n${body}\n`;
}

export function generateMinimalClaudeMd(options: InitOptions): string {
  return generateClaudeMd(options, 'minimal');
}

export const CLAUDE_MD_TEMPLATES: Array<{ name: ClaudeMdTemplate; description: string }> = [
  { name: 'minimal', description: 'Lean start — rules, agent comms, swarm config, CLI ref (~80 lines)' },
  { name: 'standard', description: 'Recommended — adds memory, learning, agent types (~140 lines)' },
  { name: 'full', description: 'Everything — hooks, intelligence, federation (~220 lines)' },
  { name: 'security', description: 'Security-focused — adds scanning, audit, threat agents' },
  { name: 'performance', description: 'Performance-focused — adds benchmarking, profiling, SONA' },
  { name: 'solo', description: 'Solo developer — comms, memory, no swarm (~90 lines)' },
];

export default generateClaudeMd;
