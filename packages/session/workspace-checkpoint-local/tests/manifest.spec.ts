import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import type { CheckpointManifest } from '@deepseek-ai/dsh-workspace-checkpoint'
import { hashCanonicalJson, hashFile } from '../src/hash.ts'
import { buildManifest, fileStatsRaced, throwIfFileRaced } from '../src/manifest.ts'
import { fromManifestPath, isContained, toManifestPath } from '../src/paths.ts'

function entry(manifest: CheckpointManifest, path: string) {
  return manifest.entries.find(item => item.relativePath === path)
}

function isPermDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')
}

describe('buildManifest', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-manifest-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('records created, modified, and deleted files as a cwd-relative manifest', async () => {
    await writeFile(join(cwd, 'kept.txt'), 'a')
    await mkdir(join(cwd, 'sub'))
    await writeFile(join(cwd, 'sub', 'nested.bin'), Buffer.from([0, 1, 2]))
    const first = await buildManifest(cwd, { excludeGlobs: [] })
    await writeFile(join(cwd, 'kept.txt'), 'b')
    await writeFile(join(cwd, 'new.txt'), 'n')
    await rm(join(cwd, 'sub', 'nested.bin'))
    const second = await buildManifest(cwd, { excludeGlobs: [] })
    expect(entry(first, 'kept.txt')?.hash).toBe(createHash('sha256').update('a').digest('hex'))
    expect(entry(first, 'sub/nested.bin')?.kind).toBe('file')
    expect(entry(first, 'kept.txt')?.hash).not.toBe(entry(second, 'kept.txt')?.hash)
    expect(entry(second, 'new.txt')?.kind).toBe('file')
    expect(entry(second, 'sub/nested.bin')).toBeUndefined()
    expect(entry(second, 'sub')?.kind).toBe('directory')
  })

  it('skips configured exclusions and does not follow symlinks', async () => {
    await writeFile(join(cwd, 'keep.txt'), 'k')
    await mkdir(join(cwd, 'node_modules'))
    await writeFile(join(cwd, 'node_modules', 'x.js'), 'ignored')
    const skipped = await buildManifest(cwd, { excludeGlobs: ['keep.txt'] })
    expect(entry(skipped, 'keep.txt')).toBeUndefined()
    const manifest = await buildManifest(cwd, { excludeGlobs: ['**/node_modules/**'] })
    expect(entry(manifest, 'node_modules')).toBeUndefined()
    expect(entry(manifest, 'node_modules/x.js')).toBeUndefined()
    expect(entry(manifest, 'keep.txt')?.kind).toBe('file')
    try {
      await symlink(join(cwd, 'keep.txt'), join(cwd, 'link.txt'))
    } catch (error) {
      if (isPermDenied(error)) return
      throw error
    }
    const withLink = await buildManifest(cwd, { excludeGlobs: ['**/node_modules/**'] })
    const link = entry(withLink, 'link.txt')
    expect(link?.kind).toBe('symlink')
    expect(link?.restoreSafe).toBe(true)
  })

  it('rejects a path that escapes the workspace', async () => {
    expect(() => fromManifestPath(cwd, '../outside.txt')).toThrow(/escapes the workspace/)
    expect(() => fromManifestPath(cwd, '/absolute')).toThrow(/not cwd-relative/)
    expect(() => fromManifestPath(cwd, '')).toThrow(/not cwd-relative/)
    expect(() => fromManifestPath(cwd, 'foo/../bar')).toThrow(/escapes the workspace/)
    expect(() => fromManifestPath(cwd, 'foo/./bar')).toThrow(/escapes the workspace/)
    expect(() => fromManifestPath(cwd, 'foo\\bar')).toThrow(/escapes the workspace/)
    expect(() => toManifestPath(cwd, join(cwd, '..', 'outside.txt'))).toThrow(/outside the workspace/)
    expect(isContained(cwd, cwd)).toBe(true)
    expect(isContained(cwd, join(cwd, 'inside.txt'))).toBe(true)
    expect(isContained(cwd, join(cwd, '..', 'outside.txt'))).toBe(false)
    expect(fromManifestPath(cwd, 'kept.txt')).toBe(join(cwd, 'kept.txt'))
    await expect(buildManifest(join(cwd, 'missing'), { excludeGlobs: [] }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_CONTAINMENT' })
    await writeFile(join(cwd, 'not-a-dir.txt'), 'x')
    await expect(buildManifest(join(cwd, 'not-a-dir.txt'), { excludeGlobs: [] }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_CONTAINMENT' })
  })

  it('hashes file bytes and detects raced lstat snapshots', async () => {
    await writeFile(join(cwd, 'kept.txt'), 'a')
    expect(await hashFile(join(cwd, 'kept.txt'))).toBe(createHash('sha256').update('a').digest('hex'))
    expect(hashCanonicalJson([])).toBe(createHash('sha256').update('[]').digest('hex'))
    const stable = {
      size: 1,
      mtimeMs: 10,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as Stats
    const withStats = (over: Partial<Stats>): Stats => Object.assign({}, stable, over)
    expect(fileStatsRaced(stable, stable)).toBe(false)
    expect(fileStatsRaced(stable, withStats({ size: 2 }))).toBe(true)
    expect(fileStatsRaced(stable, withStats({ mtimeMs: 11 }))).toBe(true)
    expect(fileStatsRaced(stable, withStats({ isFile: () => false }))).toBe(true)
    expect(fileStatsRaced(stable, withStats({ isSymbolicLink: () => true }))).toBe(true)
    expect(() =>{  throwIfFileRaced(stable, stable, 'kept.txt') }).not.toThrow()
    expect(() =>{  throwIfFileRaced(stable, withStats({ size: 2 }), 'kept.txt') })
      .toThrow(/file changed while hashing/)
    await expect(hashFile(join(cwd, 'missing.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('marks a symlink whose target leaves the workspace unsafe', async () => {
    try {
      await symlink(join(cwd, '..', 'outside.txt'), join(cwd, 'escape'))
    } catch (error) {
      if (isPermDenied(error)) return
      throw error
    }
    const manifest = await buildManifest(cwd, { excludeGlobs: [] })
    expect(entry(manifest, 'escape')?.restoreSafe).toBe(false)
  })
})
