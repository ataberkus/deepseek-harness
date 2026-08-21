/**
 * Content-addressed blob store for regular file bytes under a configured root.
 * Layout: `{objectRoot}/objects/{hash[0:2]}/{hash}`.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/objects
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { WorkspaceCheckpointError } from '@deepseek-ai/dsh-workspace-checkpoint'
import type { Config } from './config.ts'

/**
 * Resolve the object-store root from provider config.
 * @param config - local provider config.
 * @returns the absolute object-store directory.
 */
export function resolveObjectRoot(config: Config): string {
  if (config.objectRoot !== undefined) return resolve(config.objectRoot)
  return join(resolveDshHome(config.dshHome), 'workspace-checkpoints')
}

/**
 * Path of one content-addressed blob.
 * @param objectRoot - store root.
 * @param hash - SHA-256 hex digest.
 * @returns `{objectRoot}/objects/{hash[0:2]}/{hash}`.
 */
export function blobPath(objectRoot: string, hash: string): string {
  return join(objectRoot, 'objects', hash.slice(0, 2), hash)
}

/**
 * Whether a blob already exists.
 * @param objectRoot - store root.
 * @param hash - SHA-256 hex digest.
 * @returns true when the blob file is present.
 */
export async function blobExists(objectRoot: string, hash: string): Promise<boolean> {
  try {
    const info = await stat(blobPath(objectRoot, hash))
    return info.isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Write one blob if it is not already present. Existing hashes are a no-op.
 * @param objectRoot - store root.
 * @param hash - SHA-256 hex digest.
 * @param bytes - file contents; the caller already verified the digest.
 */
export async function putBlob(objectRoot: string, hash: string, bytes: Uint8Array): Promise<void> {
  if (await blobExists(objectRoot, hash)) return
  const path = blobPath(objectRoot, hash)
  await writeBlobAtomic(path, bytes)
}

/**
 * Sum the sizes of stored content blobs.
 * @param objectRoot - store root.
 * @returns total bytes of files under `objects/`.
 */
export async function totalBlobBytes(objectRoot: string): Promise<number> {
  const root = join(objectRoot, 'objects')
  let names: string[]
  try {
    names = await readdir(root, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let total = 0
  for (const name of names) {
    const path = join(root, name)
    const info = await stat(path)
    if (info.isFile()) total += info.size
  }
  return total
}

/**
 * Read one blob, or throw `CHECKPOINT_HASH_MISMATCH` when it is missing.
 * @param objectRoot - store root.
 * @param hash - SHA-256 hex digest.
 * @returns the stored bytes.
 */
export async function readBlob(objectRoot: string, hash: string): Promise<Buffer> {
  try {
    return await readFile(blobPath(objectRoot, hash))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspaceCheckpointError(`missing blob ${hash}`, 'CHECKPOINT_HASH_MISMATCH')
    }
    throw error
  }
}

/**
 * Exclusive-create temp + rename for binary blobs (the string `writeFileAtomic`
 * helper cannot carry raw file bytes).
 * @param filename - final blob path.
 * @param bytes - complete blob contents.
 */
async function writeBlobAtomic(filename: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
