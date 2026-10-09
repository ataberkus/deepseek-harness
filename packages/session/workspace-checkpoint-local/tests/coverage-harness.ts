import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type {
  CaptureRequest,
  CheckpointRecord,
  workspaceCheckpointDomainSpec,
} from '@deepseek-ai/dsh-workspace-checkpoint'
import LocalWorkspaceCheckpoint from '../src/index.ts'
import type { Config } from '../src/config.ts'

export type CheckpointDomain = Domain<typeof workspaceCheckpointDomainSpec>

export interface CoverageHarness {
  readonly ctx: Context
  readonly parent: string
  readonly cwd: string
  readonly objectRoot: string
  readonly storageRoot: string
  readonly service: LocalWorkspaceCheckpoint
  domain(): CheckpointDomain
  dispose(): Promise<void>
}

export interface BootOptions extends Partial<Omit<Config, 'objectRoot'>> {
  /** Reuse an existing parent directory (second provider over the same stores). */
  readonly parent?: string
}

/**
 * Boot the local provider over real temp stores. The caller owns `dispose()`;
 * it removes the parent directory only when this harness created it.
 */
export async function bootCoverage(options: BootOptions = {}): Promise<CoverageHarness> {
  const owned = options.parent === undefined
  const parent = options.parent ?? await mkdtemp(join(tmpdir(), 'dsh-workspace-checkpoint-coverage-'))
  const cwd = join(parent, 'cwd')
  const storageRoot = join(parent, 'storage')
  const objectRoot = join(parent, 'objects')
  await mkdir(cwd, { recursive: true })
  await mkdir(storageRoot, { recursive: true })
  await mkdir(objectRoot, { recursive: true })
  const ctx = new Context()
  const config: Config = {
    objectRoot,
    maxTotalBytes: options.maxTotalBytes ?? 1024 * 1024,
    excludeGlobs: options.excludeGlobs ?? [],
    captureRetryCount: options.captureRetryCount ?? 0,
    captureRetryDelayMs: options.captureRetryDelayMs ?? 0,
    ...options.enabled === undefined ? {} : { enabled: options.enabled },
  }
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LocalWorkspaceCheckpoint, config)
  return {
    ctx,
    parent,
    cwd,
    objectRoot,
    storageRoot,
    service: ctx.workspaceCheckpoint as LocalWorkspaceCheckpoint,
    domain: () => ctx.storageDomain.get('workspace_checkpoint') as unknown as CheckpointDomain,
    async dispose() {
      await ctx.fiber.dispose()
      if (owned) await rm(parent, { recursive: true, force: true })
    },
  }
}

/** Capture with defaults for the fields most tests do not care about. */
export function capture(
  harness: CoverageHarness,
  overrides: Omit<Partial<CaptureRequest>, 'sessionId'> & { readonly sessionId?: string } = {},
): Promise<CheckpointRecord> {
  const { sessionId, ...rest } = overrides
  return harness.ctx.workspaceCheckpoint.capture({
    sessionId: SessionId(sessionId ?? 's1'),
    cwd: harness.cwd,
    boundarySeq: -1,
    role: 'initial',
    turnOutcome: 'initial',
    ...rest,
  })
}

/**
 * Create a symlink, or report that the platform denies it (Windows without
 * the symlink privilege), so callers can skip symlink-specific assertions.
 */
export async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') return false
    throw error
  }
}
