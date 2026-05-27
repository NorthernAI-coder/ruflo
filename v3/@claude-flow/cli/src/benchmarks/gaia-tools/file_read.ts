/**
 * GAIA Tool: file_read — ADR-133-PR2
 *
 * Reads a file from the local filesystem and returns its contents as a
 * UTF-8 string.  Performs a content-type sniff based on extension +
 * magic bytes so Claude knows what it received.
 *
 * Design notes:
 * - Supported formats (PR-2): plain text, JSON, CSV, XML, HTML, Markdown,
 *   JavaScript, TypeScript, Python, shell scripts, YAML.
 * - Binary formats (PDF, DOCX, XLSX, images): returns a descriptive stub
 *   rather than raw bytes.  Full PDF text extraction is tracked for PR-4.
 * - Maximum file size: 1 MB (avoids blowing the context window).
 * - Path must be absolute to prevent directory traversal from relative paths
 *   embedded in GAIA attachment filenames.
 *
 * Refs: ADR-133, #2156
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GaiaTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Content-type detection
// ---------------------------------------------------------------------------

/** Map of file extension → human-readable media type label. */
const EXT_TO_TYPE: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  // Binary / deferred
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

/** Set of extension types that are binary / deferred and cannot be returned as text. */
const BINARY_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'video/mp4',
]);

/**
 * Detect content type from extension.  Falls back to 'application/octet-stream'.
 */
function detectContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_TYPE[ext] ?? 'application/octet-stream';
}

/**
 * Quick magic-byte check to catch binary files even when the extension is wrong.
 * Only checks the first 4 bytes.
 */
function hasBinaryMagic(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true;
  // PNG: \x89PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: \xff\xd8
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // ZIP (DOCX/XLSX are ZIP): PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate that `filePath` is safe to read:
 * - Must be a non-empty string
 * - Must be an absolute path (caller must have resolved GAIA attachment paths)
 * - Must not contain null bytes
 *
 * Does NOT check if the file exists (let the OS return ENOENT).
 */
function validatePath(filePath: string): void {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('file_read: `path` must be a non-empty string.');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `file_read: path must be absolute. Got: "${filePath}". ` +
        'Resolve relative GAIA attachment paths against the cache directory before calling file_read.',
    );
  }
  if (filePath.includes('\0')) {
    throw new Error('file_read: path contains null byte — rejected.');
  }
}

// ---------------------------------------------------------------------------
// GaiaTool implementation
// ---------------------------------------------------------------------------

export class FileReadTool implements GaiaTool {
  readonly name = 'file_read';

  readonly definition: ToolDefinition = {
    name: 'file_read',
    description:
      'Read the contents of a local file and return them as text. ' +
      'The path must be absolute. For PDF, DOCX, and image files a descriptive ' +
      'stub is returned instead of raw bytes (full extraction coming in PR-4). ' +
      `Maximum file size: ${MAX_FILE_BYTES / 1024} KB.`,
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read.',
        },
      },
      required: ['path'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<string> {
    const filePath = String(input['path'] ?? '').trim();
    validatePath(filePath);

    // Check file exists
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new Error(`file_read: file not found: ${filePath}`);
      }
      throw new Error(`file_read: cannot stat "${filePath}": ${String(e)}`);
    }

    if (!stat.isFile()) {
      throw new Error(`file_read: "${filePath}" is not a regular file.`);
    }

    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `file_read: file too large (${stat.size} bytes > ${MAX_FILE_BYTES} byte limit): ${filePath}`,
      );
    }

    // Read the file
    const buf = fs.readFileSync(filePath);

    // Content-type detection: extension first, then magic bytes
    const contentType = detectContentType(filePath);
    const isBinaryByType = BINARY_TYPES.has(contentType);
    const isBinaryByMagic = hasBinaryMagic(buf);

    if (isBinaryByType || isBinaryByMagic) {
      return (
        `[Binary file: ${contentType}]\n` +
        `Path: ${filePath}\n` +
        `Size: ${stat.size} bytes\n` +
        `Note: Text extraction for this format is not yet implemented (ADR-133 PR-4). ` +
        `If this is a GAIA attachment, describe what you expect the file to contain based on context.`
      );
    }

    // Decode as UTF-8 with a fallback to latin-1 for slightly misencoded text files.
    let text: string;
    try {
      text = buf.toString('utf-8');
    } catch {
      text = buf.toString('latin1');
    }

    const header = `[File: ${path.basename(filePath)} | type: ${contentType} | size: ${stat.size} bytes]\n\n`;
    return header + text;
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export function createFileReadTool(): FileReadTool {
  return new FileReadTool();
}
