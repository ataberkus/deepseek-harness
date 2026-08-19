/**
 * Containment helpers for cwd-relative checkpoint manifest paths.
 * Relative paths always use `/`, including on Windows.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/paths
 */

import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { WorkspaceCheckpointError } from '@deepseek-ai/dsh-workspace-checkpoint'

/**
 * Whether `candidate` stays inside canonical `root`.
 * @param root - realpath of the session cwd.
 * @param candidate - absolute path to test.
 * @returns true when `candidate` is `root` or a descendant.
 */
export function isContained(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

/**
 * Convert an absolute path under `cwd` into a slash-separated manifest path.
 * @param cwd - canonical session cwd.
 * @param absolutePath - absolute filesystem path.
 * @returns the cwd-relative path using `/` separators.
 */
export function toManifestPath(cwd: string, absolutePath: string): string {
  if (!isContained(cwd, absolutePath)) {
    throw new WorkspaceCheckpointError(
      `path is outside the workspace: ${absolutePath}`,
      'CHECKPOINT_CONTAINMENT',
    )
  }
  return relative(cwd, absolutePath).split(sep).join('/')
}

/**
 * Convert a slash-separated manifest path into an absolute path under `cwd`.
 * Rejects `..`, empty, and absolute segments.
 * @param cwd - canonical session cwd.
 * @param relativePath - slash-separated path from the manifest.
 * @returns the absolute filesystem path.
 */
export function fromManifestPath(cwd: string, relativePath: string): string {
  if (relativePath === '' || isAbsolute(relativePath)) {
    throw new WorkspaceCheckpointError(
      `manifest path is not cwd-relative: ${relativePath}`,
      'CHECKPOINT_CONTAINMENT',
    )
  }
  const segments = relativePath.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')) {
      throw new WorkspaceCheckpointError(
        `manifest path escapes the workspace: ${relativePath}`,
        'CHECKPOINT_CONTAINMENT',
      )
    }
  }
  const absolutePath = join(cwd, ...segments)
  /* v8 ignore next 6 -- join+relative round-trip holds for well-formed relative segments */
  if (toManifestPath(cwd, absolutePath) !== relativePath) {
    throw new WorkspaceCheckpointError(
      `manifest path escapes the workspace: ${relativePath}`,
      'CHECKPOINT_CONTAINMENT',
    )
  }
  return absolutePath
}

/**
 * Realpath `cwd` and require that it is a directory.
 * @param cwd - caller-supplied session cwd.
 * @returns the canonical directory path.
 */
export async function canonicalizeCwd(cwd: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(cwd)
  } catch {
    throw new WorkspaceCheckpointError(
      `workspace cwd is not a readable directory: ${cwd}`,
      'CHECKPOINT_CONTAINMENT',
    )
  }
  const info = await lstat(canonical)
  if (!info.isDirectory()) {
    throw new WorkspaceCheckpointError(
      `workspace cwd is not a directory: ${cwd}`,
      'CHECKPOINT_CONTAINMENT',
    )
  }
  return canonical
}
