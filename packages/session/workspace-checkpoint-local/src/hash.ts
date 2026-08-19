/**
 * Streaming SHA-256 helpers for workspace-checkpoint file contents and manifests.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/hash
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * SHA-256 hex digest of a regular file, streamed so large files are not buffered.
 * @param path - absolute file path.
 * @returns lowercase hex digest.
 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/**
 * SHA-256 hex digest of a canonical JSON payload.
 * @param value - JSON-serializable value; callers must already have stable key order.
 * @returns lowercase hex digest.
 */
export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
