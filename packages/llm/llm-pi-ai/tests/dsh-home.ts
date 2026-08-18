/**
 * Isolate `$DSH_HOME` so plugin-apply tests cannot read a developer's
 * `oauth-credentials.json` and inject a live `openai-codex` route.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

const dirs: string[] = []

/**
 * Point `$DSH_HOME` at a fresh empty directory for the rest of the test.
 * @returns the absolute temporary home path.
 */
export async function isolateDshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-oauth-home-'))
  dirs.push(dir)
  vi.stubEnv('DSH_HOME', dir)
  return dir
}

/** Remove homes created by {@link isolateDshHome}. */
export async function removeIsolatedHomes(): Promise<void> {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}
