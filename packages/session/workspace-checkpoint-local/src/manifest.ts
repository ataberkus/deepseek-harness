/**
 * Walk a session cwd with `lstat` (never `stat`) into a cwd-relative manifest.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/manifest
 */

import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { WorkspaceCheckpointError } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { CheckpointManifest, ManifestEntry } from '@deepseek-ai/dsh-workspace-checkpoint'
import { hashCanonicalJson, hashFile } from './hash.ts'
import { canonicalizeCwd, isContained, toManifestPath } from './paths.ts'

/** Options for {@link buildManifest}. */
export interface ManifestBuildOptions {
  /** Glob patterns matched against slash-separated relative paths. */
  readonly excludeGlobs: readonly string[]
}

/**
 * Capture one cwd as a sorted, slash-separated manifest. Does not follow symlinks.
 * @param cwd - session cwd to walk.
 * @param options - exclusion globs.
 * @returns the manifest, with `cwd` set to the realpath of the input.
 */
export async function buildManifest(cwd: string, options: ManifestBuildOptions): Promise<CheckpointManifest> {
  const root = await canonicalizeCwd(cwd)
  const entries: ManifestEntry[] = []
  await walk(root, root, options.excludeGlobs, entries)
  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1)
  return {
    cwd: root,
    hash: hashCanonicalJson(entries),
    entries,
  }
}

async function walk(
  root: string,
  directory: string,
  excludeGlobs: readonly string[],
  entries: ManifestEntry[],
): Promise<void> {
  const names = await readdir(directory)
  for (const name of names) {
    const absolutePath = join(directory, name)
    const relativePath = toManifestPath(root, absolutePath)
    const info = await lstat(absolutePath)
    if (info.isSymbolicLink()) {
      if (isExcluded(relativePath, excludeGlobs, false)) continue
      entries.push(await symlinkEntry(root, absolutePath, relativePath, info))
      continue
    }
    if (info.isDirectory()) {
      if (isExcluded(relativePath, excludeGlobs, true)) continue
      entries.push(directoryEntry(relativePath, info))
      await walk(root, absolutePath, excludeGlobs, entries)
      continue
    }
    if (isExcluded(relativePath, excludeGlobs, false)) continue
    if (info.isFile()) {
      entries.push(await fileEntry(absolutePath, relativePath, info))
      continue
    }
    /* v8 ignore next 8 -- sockets, devices, and FIFOs are not created by the unit tests */
    entries.push({
      relativePath,
      kind: 'file',
      size: Number(info.size),
      restoreSafe: false,
      ...modeOf(info),
    })
  }
}

function isExcluded(relativePath: string, globs: readonly string[], directory: boolean): boolean {
  return globs.some(glob =>
    posix.matchesGlob(relativePath, glob)
    || (directory && posix.matchesGlob(`${relativePath}/`, glob)))
}

function modeOf(info: Stats): { mode: number } {
  return { mode: info.mode }
}

function directoryEntry(relativePath: string, info: Stats): ManifestEntry {
  return {
    relativePath,
    kind: 'directory',
    size: 0,
    restoreSafe: true,
    ...modeOf(info),
  }
}

/**
 * Whether two `lstat` snapshots disagree about one regular file.
 * @param before - metadata captured before hashing.
 * @param after - metadata captured after hashing.
 * @returns true when size, mtime, or type raced.
 */
export function fileStatsRaced(before: Stats, after: Stats): boolean {
  return after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.isSymbolicLink() || !after.isFile()
}

/**
 * Reject a file whose metadata changed between the pre-hash and post-hash `lstat`.
 * @param before - metadata captured before hashing.
 * @param after - metadata captured after hashing.
 * @param relativePath - slash-separated path used in the error message.
 */
export function throwIfFileRaced(before: Stats, after: Stats, relativePath: string): void {
  if (!fileStatsRaced(before, after)) return
  throw new WorkspaceCheckpointError(
    `file changed while hashing: ${relativePath}`,
    'CHECKPOINT_CONCURRENT_WRITE',
  )
}

async function fileEntry(absolutePath: string, relativePath: string, before: Stats): Promise<ManifestEntry> {
  const hash = await hashFile(absolutePath)
  const after = await lstat(absolutePath)
  throwIfFileRaced(before, after, relativePath)
  return {
    relativePath,
    kind: 'file',
    size: Number(before.size),
    hash,
    restoreSafe: true,
    ...modeOf(before),
  }
}

async function symlinkEntry(
  root: string,
  absolutePath: string,
  relativePath: string,
  info: Stats,
): Promise<ManifestEntry> {
  const linkTarget = await readlink(absolutePath)
  const lexical = resolve(dirname(absolutePath), linkTarget)
  let resolved = lexical
  try {
    resolved = await realpath(absolutePath)
  } catch {
    // Dangling, permission, or loop: restore safety uses the lexical target only.
  }
  return {
    relativePath,
    kind: 'symlink',
    size: 0,
    linkTarget,
    restoreSafe: isContained(root, lexical) && isContained(root, resolved),
    ...modeOf(info),
  }
}
