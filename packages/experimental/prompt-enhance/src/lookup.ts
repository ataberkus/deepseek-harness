/**
 * Read-only workspace lookups the enhancer model may request: `read`, `grep`,
 * and `glob`, confined to the Session working directory. They run privately
 * inside the enhancement call: no tool registry dispatch, no tool policy, and
 * no Session event, so the Session's own tools, observations, and log are
 * untouched. Search spawns the packaged ripgrep through `ctx.subprocess`
 * exactly like `@deepseek-ai/dsh-tool-fs-search`, whose argv and output helpers
 * this module reuses; `glob` additionally honors ignore files.
 * @module @deepseek-ai/dsh-experimental-prompt-enhance/lookup
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  buildGrepCommand,
  formatGrepMatches,
  GLOB_VCS_EXCLUDES,
  GREP_MAX_LINE_BYTES,
  parseGlobArgs,
  parseGrepArgs,
  parseGrepMatches,
  previewLine,
  runRipgrep,
  SEARCH_GRACE_MS,
  SEARCH_STDERR_MAX_BYTES,
  toWorkdirRelative,
} from '@deepseek-ai/dsh-tool-fs-search'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

/** Lookup tool names, in schema order. */
export type LookupTool = 'read' | 'grep' | 'glob'

/** Progress fact of one accepted lookup: the tool and its workspace-relative target or pattern. */
export interface LookupStep {
  readonly tool: LookupTool
  readonly target: string
}

/** Per-call resources and bounds of the lookups. */
export interface LookupLimits {
  /** Largest file `read` loads, and largest raw ripgrep output a search parses, in bytes. */
  readonly scanMaxBytes: number
  /** Longest model-facing lookup result, in characters; longer results are cut with a notice. */
  readonly resultMaxChars: number
}

/** Model-facing schemas of the lookup tools. */
export const LOOKUP_TOOLS: readonly ToolSchema[] = [
  {
    name: 'read',
    description: 'Read a text file in the workspace. Returns numbered lines.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path, relative to the workspace or absolute inside it.' },
        offset: { type: 'integer', minimum: 1, description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description: 'Search file contents in the workspace with a ripgrep regular expression. Returns matching lines grouped by file.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression (ripgrep syntax).' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the workspace.' },
        include: { type: 'string', description: 'One glob filter for which files to search, e.g. "*.ts".' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description: 'List workspace files whose paths match a glob pattern, most recently modified first. Ignored files are skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/**/index.*".' },
        path: { type: 'string', description: 'Directory to search in. Defaults to the workspace.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
]

/** A lookup refused or failed; its message is the model-facing error result. */
export class LookupError extends Error {}

/** One accepted lookup: its progress fact and the deferred execution. */
export interface PreparedLookup {
  readonly step: LookupStep
  /** @returns the model-facing result text; rejects with the failure the model receives as an error result. */
  run(): Promise<string>
}

type Args = Record<string, unknown>

function stringArg(args: Args, key: string, required: true): string
function stringArg(args: Args, key: string, required: false): string | undefined
function stringArg(args: Args, key: string, required: boolean): string | undefined {
  const value = args[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new LookupError(`${key} must be a string`)
  return value
}

function lineArg(args: Args, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new LookupError(`${key} must be a positive integer`)
  return value
}

/** Cut a result to the character budget and say so. */
export function boundResult(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… (result truncated; narrow the request)`
}

/**
 * Resolve `path` inside the workspace after following symlinks.
 * @returns the workspace-relative path (`.` for the root).
 * @throws LookupError when the path is missing or leaves the workspace.
 */
async function confine(workspace: string, path: string): Promise<string> {
  let root: string
  let target: string
  try {
    root = await realpath(workspace)
    target = await realpath(resolve(workspace, path))
  } catch {
    // Swallows the fs error: a missing path is an ordinary lookup miss the model can correct.
    throw new LookupError(`${path} does not exist`)
  }
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new LookupError(`${path} is outside the workspace`)
  return rel === '' ? '.' : rel
}

/** The minimal execution record `runRipgrep` reads: the Session cwd and the cancellation signal. */
function searchExecution(agent: Agent, signal: AbortSignal): ToolExecution {
  const callId = ToolCallId('prompt-enhance-lookup')
  return {
    callId, rootCallId: callId, name: 'prompt-enhance-lookup', arguments: null, agent, signal,
    token: Symbol('prompt-enhance-lookup') as ToolExecutionToken,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Validate one model tool call and prepare its execution.
 * @param ctx - plugin context; searches use its `subprocess` service.
 * @param agent - the enhanced Session's Agent; its cwd is the workspace.
 * @param name - requested tool name.
 * @param rawArguments - the model's JSON argument text.
 * @param limits - result and scan bounds.
 * @param signal - cancels a running search.
 * @returns the prepared lookup.
 * @throws LookupError for an unknown tool or invalid arguments.
 */
export function prepareLookup(
  ctx: Context,
  agent: Agent,
  name: string,
  rawArguments: string,
  limits: LookupLimits,
  signal: AbortSignal,
): PreparedLookup {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments === '' ? '{}' : rawArguments)
  } catch {
    // Swallows the parse error: malformed arguments are reported to the model below.
    throw new LookupError('arguments must be a JSON object')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LookupError('arguments must be a JSON object')
  const args = parsed as Args
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new LookupError('this session has no workspace to look up')
  const bound = (text: string): string => boundResult(text, limits.resultMaxChars)
  switch (name) {
    case 'read': {
      const filePath = stringArg(args, 'file_path', true)
      const offset = lineArg(args, 'offset') ?? 1
      const limit = lineArg(args, 'limit')
      return {
        step: { tool: 'read', target: filePath },
        run: async () => {
          const rel = await confine(cwd, filePath)
          const absolute = resolve(cwd, rel)
          const info = await stat(absolute)
          if (!info.isFile()) throw new LookupError(`${filePath} is not a file`)
          if (info.size > limits.scanMaxBytes) throw new LookupError(`${filePath} is larger than ${String(limits.scanMaxBytes)} bytes`)
          const text = await readFile(absolute, { encoding: 'utf8', signal })
          if (text.includes('\u0000')) throw new LookupError(`${filePath} is a binary file`)
          const lines = text.split(/\r?\n/u)
          const end = limit === undefined ? lines.length : Math.min(lines.length, offset - 1 + limit)
          if (offset > lines.length) return `(${filePath} has ${String(lines.length)} lines)`
          return bound(lines.slice(offset - 1, end).map((line, index) => `${String(offset + index)}\t${line}`).join('\n'))
        },
      }
    }
    case 'grep': {
      const input = parseArgs(() => parseGrepArgs({
        pattern: stringArg(args, 'pattern', true),
        ...optional('path', stringArg(args, 'path', false)),
        ...optional('include', stringArg(args, 'include', false)),
      }))
      return {
        step: { tool: 'grep', target: input.pattern },
        run: async () => {
          const path = await confine(cwd, input.path ?? '.')
          const run = await runRipgrep(ctx, searchExecution(agent, signal), 'grep', buildGrepCommand({ pattern: input.pattern, ...optional('include', input.include), ...optional('path', root(path)) }),
            limits.scanMaxBytes, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES)
          if (run.noMatches) return 'No matches found'
          const matches = parseGrepMatches(run.stdout).map(match => ({
            path: toWorkdirRelative(match.path, run.workdir),
            lineNumber: match.lineNumber,
            line: previewLine(match.line, GREP_MAX_LINE_BYTES),
          }))
          return bound(`Found ${String(matches.length)} ${matches.length === 1 ? 'match' : 'matches'}\n\n${formatGrepMatches(matches)}`)
        },
      }
    }
    case 'glob': {
      const input = parseArgs(() => parseGlobArgs({
        pattern: stringArg(args, 'pattern', true),
        ...optional('path', stringArg(args, 'path', false)),
      }))
      return {
        step: { tool: 'glob', target: input.pattern },
        run: async () => {
          const path = await confine(cwd, input.path ?? '.')
          // A positive ripgrep --glob overrides ignore files, so ripgrep lists the
          // non-ignored files and the pattern filters them here.
          const argv = [
            '--files', '--sort=modified', '--hidden',
            ...GLOB_VCS_EXCLUDES.flatMap(vcs => [`--glob=!**/${vcs}`, `--glob=!**/${vcs}/**`]),
            ...path === '.' ? [] : ['--', path],
          ]
          const run = await runRipgrep(ctx, searchExecution(agent, signal), 'glob', argv,
            limits.scanMaxBytes, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES)
          const pattern = input.pattern.replaceAll('\\', '/')
          const paths = run.stdout.split('\n')
            .filter(line => line !== '')
            .map(line => toWorkdirRelative(line, run.workdir))
            .filter(display => globMatches(pattern, relative(path, display).replaceAll('\\', '/')))
          return paths.length === 0 ? 'No files found' : bound(paths.join('\n'))
        },
      }
    }
    default:
      throw new LookupError(`unknown tool "${name}"; use read, grep, or glob`)
  }
}

/**
 * Match one search-root-relative `/` path with ripgrep's glob convention: a
 * pattern without `/` matches the basename at any depth.
 */
function globMatches(pattern: string, path: string): boolean {
  return posix.matchesGlob(pattern.includes('/') ? path : posix.basename(path), pattern)
}

/** The search root argument; the workspace root is ripgrep's default and keeps output paths unprefixed. */
function root(path: string): string | undefined {
  return path === '.' ? undefined : path
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string }
}

function parseArgs<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error: unknown) {
    throw error instanceof LookupError ? error : new LookupError(errorText(error))
  }
}

/**
 * Run a prepared lookup as a model-facing tool result.
 * @param lookup - the prepared lookup.
 * @returns the result text and whether it failed.
 */
export async function settleLookup(lookup: PreparedLookup): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: await lookup.run(), isError: false }
  } catch (error: unknown) {
    return { text: errorText(error), isError: true }
  }
}
