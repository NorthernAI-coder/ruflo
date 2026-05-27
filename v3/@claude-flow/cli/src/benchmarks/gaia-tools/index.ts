/**
 * gaia-tools barrel — ADR-133-PR2/PR5
 *
 * Exports all tool implementations + shared types so that gaia-agent.ts
 * (PR-3) and future iterations can import from a single entry point.
 *
 * Catalogue evolution:
 *   PR-2: web_search + file_read
 *   PR-4: + python_exec (local Python 3 subprocess — see python_exec.ts)
 *   PR-5: + web_browse (Playwright headless) + image_describe (Anthropic vision)
 *
 * NOTE: When PR-4 (python_exec) merges alongside this PR, resolve the textual
 * conflict in this file by including BOTH the python_exec import/export AND the
 * web_browse/image_describe additions.  There is no logical conflict — the two
 * PRs add independent tool entries to the same array.
 *
 * Refs: ADR-133, #2156
 */

export * from './types.js';
export * from './web_search.js';
export * from './file_read.js';
export * from './web_browse.js';
export * from './image_describe.js';

import { createWebSearchTool } from './web_search.js';
import { createFileReadTool } from './file_read.js';
import { createWebBrowseTool, type WebBrowseToolOptions } from './web_browse.js';
import { createImageDescribeTool, type ImageDescribeToolOptions } from './image_describe.js';
import type { GaiaToolCatalogue } from './types.js';

export interface GaiaToolCatalogueOptions {
  webBrowse?: WebBrowseToolOptions;
  imageDescribe?: ImageDescribeToolOptions;
}

/**
 * Returns the default tool catalogue for a GAIA Level-1 run.
 *
 * PR-2 catalogue: web_search + file_read
 * PR-5 catalogue: + web_browse (Playwright) + image_describe (Anthropic vision)
 *
 * python_exec (PR-4) will be added when that PR merges — see conflict note
 * in this file's header.
 */
export function createDefaultToolCatalogue(opts?: GaiaToolCatalogueOptions): GaiaToolCatalogue {
  return [
    createWebSearchTool(),
    createFileReadTool(),
    createWebBrowseTool(opts?.webBrowse),
    createImageDescribeTool(opts?.imageDescribe),
  ];
}
