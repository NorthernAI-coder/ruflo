#!/usr/bin/env node
/**
 * @claude-flow/cli-core entry point — alpha.1 surface.
 *
 * Status: alpha (ADR-100). alpha.1 lands the MemoryBackend abstraction +
 * a working `memory` command surface backed by JsonMemoryBackend.
 *
 * Stable exports:
 *   - types: CommandContext, Command, CommandResult, ParsedFlags
 *   - output: terminal printing + tables + spinners + progress
 *   - mcp-tools/types: MCPTool, MCPToolInputSchema, MCPToolResult
 *   - mcp-tools/validate-input: input bounds and shape validators
 *   - memory: MemoryBackend, MemoryEntry, MemorySearchResult, JsonMemoryBackend
 *
 * Working CLI surface (alpha.1):
 *   memory store <key> <value> [--namespace] [--tags] [--ttl] [--upsert] [--format=json]
 *   memory retrieve <key>      [--namespace] [--format=json]
 *   memory list                [--namespace] [--limit] [--tags] [--format=json]
 *   memory search <query>      [--namespace] [--limit] [--threshold] [--format=json]
 *   memory delete <key>        [--namespace] [--format=json]
 *   memory stats               [--format=json]
 *
 * Coming in alpha.2 (ADR-100 §Discovery):
 *   - mcp-tools/memory: memory_* MCPTool definitions wired to the backend
 *   - mcp-tools/hooks:  hooks_* MCPTool definitions (def-only — handlers
 *                       stay in @claude-flow/cli, dynamic-imported)
 *   - hooks command surface (the second half of the lite path)
 */

import { fileURLToPath } from 'node:url';
import { runMemoryCommand } from './commands/memory.js';

// Re-export foundation surface so plugin authors can pin to cli-core.
export * from './types.js';
export * as output from './output.js';
export type { MCPTool, MCPToolInputSchema, MCPToolResult } from './mcp-tools/types.js';
export * as validateInput from './mcp-tools/validate-input.js';

// Memory abstraction — alpha.1
export type {
  MemoryBackend,
  MemoryEntry,
  MemorySearchResult,
  MemoryStats,
  StoreOptions,
  SearchOptions,
  ListOptions,
} from './memory/backend.js';
export { JsonMemoryBackend } from './memory/json-backend.js';
export { runMemoryCommand } from './commands/memory.js';

// Bin entry — runs when invoked as `claude-flow-core <command>`.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('cli-core/dist/src/index.js') ||
  process.argv[1]?.endsWith('cli-core/dist/src/index.js ');

if (isMain) {
  const args = process.argv.slice(2);

  if (args[0] === '--version' || args[0] === '-v') {
    const url = new URL('../../package.json', import.meta.url);
    const fs = await import('node:fs/promises');
    const pkg = JSON.parse(await fs.readFile(fileURLToPath(url), 'utf-8'));
    console.log(pkg.version);
    process.exit(0);
  }

  if (args[0] === 'memory') {
    const code = await runMemoryCommand(args.slice(1));
    process.exit(code);
  }

  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    console.log(`@claude-flow/cli-core — alpha.1 (ADR-100)

Lite core surface: <250 KB packed, <1s cold-cache. Memory + (coming) hooks only.

Working subcommands:
  memory store <key> <value> [--namespace] [--tags] [--ttl] [--upsert]
  memory retrieve <key>      [--namespace]
  memory list                [--namespace] [--limit] [--tags]
  memory search <query>      [--namespace] [--limit] [--threshold]
  memory delete <key>        [--namespace]
  memory stats

  All subcommands accept --format=json for machine-readable output.

Storage:
  JsonMemoryBackend writes to .swarm/memory.json by default. Override with
  CLAUDE_FLOW_MEMORY_PATH or --path. Search is substring-only — for semantic
  vector search, install the heavy @claude-flow/cli@alpha.

Programmatic use:
  import { JsonMemoryBackend, runMemoryCommand } from '@claude-flow/cli-core';

Track progress: https://github.com/ruvnet/ruflo/issues/1760`);
    process.exit(0);
  }

  console.error(`@claude-flow/cli-core: command "${args[0]}" not yet wired into cli-core.
For now, use the full CLI:  npx @claude-flow/cli@alpha ${args.join(' ')}`);
  process.exit(1);
}
