/** Enhancer lookups read and search only inside the Session workspace and report failures to the model. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boundResult, LOOKUP_TOOLS, LookupError, prepareLookup, settleLookup } from '../src/lookup.ts'

let root: string
let workspace: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'prompt-enhance-lookup-'))
  workspace = join(root, 'ws')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'a.ts'), 'export const alpha = 1\nexport const beta = 2\n')
  await writeFile(join(workspace, 'notes.md'), 'alpha notes\n')
  await writeFile(join(workspace, 'blob.bin'), Buffer.from([0x61, 0, 0x62]))
  await writeFile(join(workspace, '.ignore'), 'ignored.ts\n')
  await writeFile(join(workspace, 'ignored.ts'), 'alpha\n')
  await mkdir(join(workspace, '.git'))
  await writeFile(join(root, 'secret.txt'), 'outside\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A subprocess seam that runs the real ripgrep binary. */
const ctx: Context = {
  subprocess: {
    spawn: (spec: SubprocessSpawnSpec) => {
      const [file, ...args] = spec.argv
      const done = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        // stdin stays closed like the production seam's `ignore`; a piped stdin makes ripgrep search it.
        const child = spawn(file!, args, { cwd: spec.cwd, signal: spec.signal, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
        child.on('close', (code) => { resolve({ stdout, stderr, exitCode: code ?? 2 }) })
      })
      let result: { stdout: string; stderr: string; exitCode: number } | undefined
      return {
        done: done.then((r) => { result = r; return { exitCode: r.exitCode, signal: null } }),
        collected: {
          stdout: { readFrom: () => ({ text: result!.stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: result!.stderr, lossy: false }) },
        },
      }
    },
  },
} as never

const agent = (cwd: string | undefined): Agent => ({ session: { header: { cwd } } }) as never
const limits = { scanMaxBytes: 100_000, resultMaxChars: 2000 }
const signal = new AbortController().signal

async function run(name: string, args: Record<string, unknown>, cwd: string | undefined = workspace) {
  const lookup = prepareLookup(ctx, agent(cwd), name, JSON.stringify(args), limits, signal)
  return { step: lookup.step, ...await settleLookup(lookup) }
}

describe('lookup schemas', () => {
  it('declares read, grep, and glob', () => {
    expect(LOOKUP_TOOLS.map(tool => tool.name)).toEqual(['read', 'grep', 'glob'])
  })
})

describe('read', () => {
  it('returns numbered lines within the requested window', async () => {
    expect(await run('read', { file_path: 'src/a.ts' })).toEqual({
      step: { tool: 'read', target: 'src/a.ts' }, isError: false, text: '1\texport const alpha = 1\n2\texport const beta = 2\n3\t',
    })
    expect((await run('read', { file_path: join(workspace, 'src', 'a.ts'), offset: 2, limit: 1 })).text).toBe('2\texport const beta = 2')
    expect((await run('read', { file_path: 'src/a.ts', offset: 9 })).text).toBe('(src/a.ts has 3 lines)')
  })

  it('refuses paths outside the workspace, directories, binaries, large and missing files', async () => {
    expect(await run('read', { file_path: '../secret.txt' })).toMatchObject({ isError: true, text: '../secret.txt is outside the workspace' })
    expect(await run('read', { file_path: 'src' })).toMatchObject({ isError: true, text: 'src is not a file' })
    expect(await run('read', { file_path: 'blob.bin' })).toMatchObject({ isError: true, text: 'blob.bin is a binary file' })
    expect(await run('read', { file_path: 'missing.ts' })).toMatchObject({ isError: true, text: 'missing.ts does not exist' })
    const small = prepareLookup(ctx, agent(workspace), 'read', '{"file_path":"src/a.ts"}', { ...limits, scanMaxBytes: 4 }, signal)
    expect(await settleLookup(small)).toEqual({ isError: true, text: 'src/a.ts is larger than 4 bytes' })
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink that leaves the workspace', async () => {
    await symlink(join(root, 'secret.txt'), join(workspace, 'link.txt'))
    expect(await run('read', { file_path: 'link.txt' })).toMatchObject({ isError: true, text: 'link.txt is outside the workspace' })
  })
})

describe('grep and glob', () => {
  it('search the workspace honoring ignore files', async () => {
    const grep = await run('grep', { pattern: 'const alpha' })
    expect(grep.step).toEqual({ tool: 'grep', target: 'const alpha' })
    expect(grep.text).toBe(`Found 1 match\n\n${join('src', 'a.ts')}\nLine 1: export const alpha = 1`)
    expect((await run('grep', { pattern: 'alpha', path: 'src', include: '*.ts' })).text).toContain('Found 1 match')
    expect((await run('grep', { pattern: 'alpha' })).text).not.toContain('ignored.ts')
    expect((await run('grep', { pattern: 'gamma' })).text).toBe('No matches found')
    const glob = await run('glob', { pattern: '*.ts' })
    expect(glob).toMatchObject({ step: { tool: 'glob', target: '*.ts' }, isError: false, text: join('src', 'a.ts') })
    expect((await run('glob', { pattern: '*.none', path: 'src' })).text).toBe('No files found')
    expect((await run('glob', { pattern: 'src/*.ts' })).text).toBe(join('src', 'a.ts'))
    expect((await run('glob', { pattern: '*.ts', path: 'src' })).text).toBe(join('src', 'a.ts'))
  })

  it('refuses search roots outside the workspace and reports ripgrep failures', async () => {
    expect(await run('grep', { pattern: 'x', path: '..' })).toMatchObject({ isError: true, text: '.. is outside the workspace' })
    expect(await run('glob', { pattern: '*', path: '../..' })).toMatchObject({ isError: true })
    const rejected = await run('grep', { pattern: '(' })
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toContain('pattern rejected')
  })
})

describe('argument validation', () => {
  const prepare = (name: string, raw: string) => () => prepareLookup(ctx, agent(workspace), name, raw, limits, signal)

  it('rejects malformed calls before running', () => {
    expect(prepare('read', 'nope')).toThrow(new LookupError('arguments must be a JSON object'))
    expect(prepare('read', '[]')).toThrow('arguments must be a JSON object')
    expect(prepare('read', '')).toThrow('file_path must be a string')
    expect(prepare('read', '{"file_path":"a","offset":0}')).toThrow('offset must be a positive integer')
    expect(prepare('grep', '{"pattern":""}')).toThrow('pattern must be a non-empty string')
    expect(prepare('grep', '{"pattern":"a","include":"!x"}')).toThrow(LookupError)
    expect(prepare('glob', '{"pattern":"a","path":1}')).toThrow('path must be a string')
    expect(prepare('write', '{}')).toThrow('unknown tool "write"')
    expect(() => prepareLookup(ctx, agent(undefined), 'read', '{"file_path":"a"}', limits, signal)).toThrow('no workspace')
  })

  it('reports a non-Error failure as text', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    expect(await settleLookup({ step: { tool: 'read', target: 'x' }, run: () => Promise.reject('gone') })).toEqual({ text: 'gone', isError: true })
  })

  it('cuts long results with a notice', () => {
    expect(boundResult('abcdef', 3)).toBe('abc\n… (result truncated; narrow the request)')
    expect(boundResult('abc', 3)).toBe('abc')
  })
})
