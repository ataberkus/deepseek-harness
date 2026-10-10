import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

const CONFIG = {
  maxDraftChars: 100, historyMessages: 2, historyMessageChars: 50, instructionsMaxChars: 100,
  maxToolCalls: 2, toolResultMaxChars: 500, scanMaxBytes: 10_000,
  maxOutputTokens: 200, timeoutMs: 5_000, maxConcurrent: 1,
} satisfies Config

const answer = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const lookupCall = (id: string, name: string, args: unknown): StreamChunk[] => [
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { id } } },
]

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface Reply {
  readonly status: number
  /** JSON error body, or the NDJSON frames of an accepted call. */
  readonly body: unknown
}

interface Harness {
  readonly post: (body: unknown, headers?: Record<string, string>, signal?: AbortSignal) => Promise<Reply>
  readonly get: () => Promise<Response>
  readonly requests: GenerateOptions[]
  /** Point the fake Session at a real directory. */
  readonly setCwd: (cwd: string) => void
}

interface Attachments {
  imageLimits: { maxMessageImageBytes: number; maxImagesPerMessage: number }
  admitPromptContent: (parts: readonly unknown[]) => Promise<unknown[]>
  isAttachmentError: (error: unknown) => boolean
}

async function boot(options: {
  config?: Partial<Config>
  chunks?: (request: GenerateOptions, round: number) => AsyncIterable<StreamChunk>
  rejection?: 401 | 403
  pending?: { provider: string; model: string; reasoningEffort?: string }
  history?: Message[]
  attachments?: Attachments
  defaultEffort?: string
  subprocess?: (spec: SubprocessSpawnSpec) => unknown
} = {}): Promise<Harness> {
  let handler: Handler | undefined
  const requests: GenerateOptions[] = []
  const session = {
    header: { cwd: '/repo' },
    deriveMessages: () => options.history ?? [],
  }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    webServer: { register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => options.rejection },
    agents: { get: (id: string) => id === 'session-1' ? { session } : undefined },
    llm: {
      stream: (request: GenerateOptions) => {
        // The loop appends to the live array; snapshot what this request saw.
        requests.push({ ...request, messages: [...request.messages] })
        return options.chunks?.(request, requests.length - 1) ?? (async function* () { yield* answer('```\nRewritten prompt\n```') })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({
      provider: 'default-p', model: 'default-m', ...options.defaultEffort === undefined ? {} : { reasoningEffort: options.defaultEffort },
    }) },
    subprocess: { spawn: (spec: SubprocessSpawnSpec) => options.subprocess?.(spec) },
    get: (name: string) => {
      if (name === 'sessionProjections' && options.pending !== undefined) return { stateOf: () => ({ pending: options.pending, lastUsed: null }) }
      if (name === 'attachments') return options.attachments
      return undefined
    },
    logger: { warn: () => {} },
  }
  // The stub carries only the services the route reads.
  apply(ctx as never, { ...CONFIG, ...options.config })
  const server = createServer((req, res) => { void handler!(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${String(port)}/prompt-enhance`
  return {
    requests,
    setCwd: (cwd) => { session.header.cwd = cwd },
    get: () => fetch(url),
    post: async (body, headers = { 'content-type': 'application/json' }, signal) => {
      const response = await fetch(url, {
        method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), ...signal === undefined ? {} : { signal },
      })
      const text = await response.text()
      if (response.headers.get('content-type')?.startsWith('application/x-ndjson') === true) {
        return { status: response.status, body: text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as unknown) }
      }
      return { status: response.status, body: text === '' ? undefined : JSON.parse(text) as unknown }
    },
  }
}

const userText = (request: GenerateOptions): unknown => request.messages[0]!.content[0]

describe('prompt-enhance route', () => {
  it('streams the rewrite with the default model and strips the fence', async () => {
    const harness = await boot()
    const result = await harness.post({ sessionId: 'session-1', text: 'fix it' })
    expect(result).toEqual({ status: 200, body: [
      { type: 'start', provider: 'default-p', model: 'default-m' },
      { type: 'done', text: 'Rewritten prompt' },
    ] })
    const [request] = harness.requests
    expect(request).toMatchObject({ provider: 'default-p', model: 'default-m', maxTokens: 200 })
    expect(request!.tools?.map(tool => tool.name)).toEqual(['read', 'grep', 'glob'])
    expect(request!.system).toContain('at most 2 read, grep or glob calls')
    expect(userText(request!)).toEqual({ type: 'text', text: '<workspace>/repo</workspace>\n<draft>\nfix it\n</draft>' })
  })

  it('shows loaded workspace instructions and recent prompts', async () => {
    const history = [
      createUserMessage({ content: [{ type: 'text', text: 'Use pnpm.' }], source: { kind: 'agent-instructions' } as never }),
      createUserMessage({ content: [{ type: 'text', text: 'earlier ask' }], source: { kind: 'user' } }),
    ]
    const harness = await boot({ history })
    await harness.post({ sessionId: 'session-1', text: 'go' })
    expect(userText(harness.requests[0]!)).toEqual({ type: 'text', text:
      '<workspace>/repo</workspace>\n<instructions>\nUse pnpm.\n</instructions>\n<conversation>\nUser: earlier ask\n</conversation>\n<draft>\ngo\n</draft>' })
  })

  it('runs lookups, reports each step, and feeds results back with replay state', async () => {
    const harness = await boot({ chunks: (_request, round) => (async function* () {
      if (round === 0) yield* lookupCall('c1', 'read', { file_path: 'missing.ts' })
      else if (round === 1) yield* lookupCall('c2', 'write', {})
      else yield* answer('Done')
    })() })
    const result = await harness.post({ sessionId: 'session-1', text: 'fix it' })
    expect(result.body).toEqual([
      { type: 'start', provider: 'default-p', model: 'default-m' },
      { type: 'step', tool: 'read', target: 'missing.ts' },
      { type: 'done', text: 'Done' },
    ])
    const last = harness.requests[2]!.messages
    expect(last.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool'])
    expect(last[1]).toMatchObject({ source: { kind: 'model', provider: 'default-p', model: 'default-m', replayState: { response: { id: 'c1' } } } })
    expect(last[2]).toMatchObject({ toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'missing.ts does not exist' }] })
    expect(last[4]).toMatchObject({ toolCallId: 'c2', isError: true })
    expect(JSON.stringify(last[4]!.content)).toContain('unknown tool')
  })

  it('refuses lookups past the budget and fails a model that never answers', async () => {
    const harness = await boot({ config: { maxToolCalls: 1 }, chunks: (_request, round) => (async function* () {
      yield* lookupCall(`c${String(round)}`, 'read', { file_path: 'a.ts' })
    })() })
    const result = await harness.post({ sessionId: 'session-1', text: 'x' })
    expect(result.body).toEqual([
      { type: 'start', provider: 'default-p', model: 'default-m' },
      { type: 'step', tool: 'read', target: 'a.ts' },
      { type: 'error', code: 'tool-calls', message: 'the model kept looking up instead of answering' },
    ])
    expect(harness.requests).toHaveLength(3)
    expect(JSON.stringify(harness.requests[2]!.messages.at(-1)!.content)).toContain('Lookup limit reached')
  })

  it('sends no tools when lookups are disabled', async () => {
    const harness = await boot({ config: { maxToolCalls: 0 } })
    await harness.post({ sessionId: 'session-1', text: 'go' })
    expect(harness.requests[0]!.tools).toBeUndefined()
    expect(harness.requests[0]!.system).not.toContain('read, grep or glob')
  })

  it('stores draft images and shows them to the model', async () => {
    const admitted: unknown[] = []
    const attachments: Attachments = {
      imageLimits: { maxMessageImageBytes: 30, maxImagesPerMessage: 1 },
      admitPromptContent: async (parts) => {
        admitted.push(...parts)
        return [{ type: 'text', text: 'ignored' }, { type: 'image', attachment: { attachmentId: 'att-1' } }]
      },
      isAttachmentError: () => false,
    }
    const harness = await boot({ attachments })
    const image = { mediaType: 'image/png', data: 'AA==', name: 'shot.png' }
    expect((await harness.post({ sessionId: 'session-1', text: 'go', images: [image] })).status).toBe(200)
    expect(admitted).toEqual([{ type: 'image', ...image }])
    expect(harness.requests[0]!.messages[0]!.content[1]).toEqual({ type: 'image', attachment: { attachmentId: 'att-1' } })
    expect(harness.requests[0]!.system).toContain('Images are attached')
    expect((await harness.post({ sessionId: 'session-1', text: 'go', images: [{ ...image, data: 'A'.repeat(3000) }] })).status).toBe(413)
  })

  it('refuses images it cannot store', async () => {
    const image = { mediaType: 'image/png', data: 'AA==' }
    const none = await boot()
    expect(await none.post({ sessionId: 'session-1', text: 'go', images: [image] })).toMatchObject({ status: 400, body: { code: 'images-unsupported' } })
    const refusing = await boot({ attachments: {
      imageLimits: { maxMessageImageBytes: 100, maxImagesPerMessage: 2 },
      admitPromptContent: async () => { throw Object.assign(new Error('too many'), { code: 'IMAGE_COUNT' }) },
      isAttachmentError: () => true,
    } })
    expect(await refusing.post({ sessionId: 'session-1', text: 'go', images: [image] })).toEqual({ status: 400, body: { code: 'IMAGE_COUNT', message: 'too many' } })
    const broken = await boot({ attachments: {
      imageLimits: { maxMessageImageBytes: 100, maxImagesPerMessage: 2 },
      admitPromptContent: async () => { throw new Error('disk full') },
      isAttachmentError: () => false,
    } })
    expect(await broken.post({ sessionId: 'session-1', text: 'go', images: [image] })).toEqual({ status: 502, body: { code: 'llm-failed', message: 'disk full' } })
  })

  it('uses the Session pending selection and a configured effort', async () => {
    const harness = await boot({ pending: { provider: 'p', model: 'm', reasoningEffort: 'high' }, config: { reasoningEffort: 'low' } })
    expect((await harness.post({ sessionId: 'session-1', text: 'go' })).status).toBe(200)
    expect(harness.requests[0]).toMatchObject({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  })

  it('prefers a configured route', async () => {
    const harness = await boot({ config: { provider: 'fixed', model: 'fast' }, pending: { provider: 'p', model: 'm' } })
    await harness.post({ sessionId: 'session-1', text: 'go' })
    expect(harness.requests[0]).toMatchObject({ provider: 'fixed', model: 'fast' })
  })

  it('rejects invalid requests at the wire', async () => {
    const harness = await boot()
    expect((await harness.post({ sessionId: 'session-1', text: 'x' }, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await harness.post('not json')).status).toBe(400)
    expect((await harness.post({ sessionId: 'session-1', text: '   ' })).status).toBe(400)
    expect((await harness.post({ sessionId: 'session-1', text: 'x', images: 'no' })).status).toBe(400)
    expect((await harness.post({ sessionId: 'session-1', text: 'x', images: [{ mediaType: 'image/bmp', data: '' }] })).status).toBe(400)
    expect((await harness.post({ sessionId: 'session-1', text: 'x', images: [{ mediaType: 'image/png', data: '', name: 1 }] })).status).toBe(400)
    expect((await harness.post({ sessionId: 'session-1', text: 'x', images: [null] })).status).toBe(400)
    expect((await harness.post({ sessionId: 'session-1', text: 'x'.repeat(101) })).status).toBe(413)
    expect(await harness.post({ sessionId: 'missing', text: 'x' })).toMatchObject({ status: 404, body: { code: 'session-not-found' } })
    expect(harness.requests).toEqual([])
  })

  it('answers the connection fence first', async () => {
    const harness = await boot({ rejection: 401 })
    expect((await harness.post({ sessionId: 'session-1', text: 'x' })).status).toBe(401)
  })

  it('streams model failures and empty answers as error frames', async () => {
    const failing = await boot({ chunks: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'auth', message: 'no key' } } }
    } })
    expect((await failing.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual({ type: 'error', code: 'auth', message: 'no key' })
    const empty = await boot({ chunks: async function* () { yield* answer('```') } })
    expect((await empty.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual(expect.objectContaining({ type: 'error', code: 'empty' }))
    const truncated = await boot({ chunks: async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } } })
    expect((await truncated.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual(expect.objectContaining({ type: 'error', code: 'max-tokens' }))
    const thrown = await boot({ chunks: async function* () { yield* []; throw new Error('socket closed') } })
    expect((await thrown.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual({ type: 'error', code: 'llm-failed', message: 'socket closed' })
  })

  it('times out a slow call', async () => {
    const harness = await boot({ config: { timeoutMs: 20 }, chunks: request => (async function* () {
      await new Promise((_resolve, reject) => { request.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }) })
      yield* answer('late')
    })() })
    expect((await harness.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual(expect.objectContaining({ type: 'error', code: 'timeout' }))
  })

  it('refuses calls beyond maxConcurrent', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const harness = await boot({ chunks: async function* () { await gate; yield* answer('done') } })
    const first = harness.post({ sessionId: 'session-1', text: 'a' })
    await expect.poll(() => harness.requests.length).toBe(1)
    expect((await harness.post({ sessionId: 'session-1', text: 'b' })).status).toBe(429)
    release()
    expect((await first).status).toBe(200)
  })

  it('reports unknown finishes, keeps only answer text, and tolerates a call without replay state', async () => {
    const odd = await boot({ chunks: async function* () { yield { type: 'finish', reason: { kind: 'paused' } } as never } })
    expect((await odd.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual(expect.objectContaining({ type: 'error', code: 'unknown-finish' }))
    const mixed = await boot({ chunks: (_request, round) => (async function* () {
      if (round === 0) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'nope', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'thinking' } }
      yield* answer('Answer')
    })() })
    expect((await mixed.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual({ type: 'done', text: 'Answer' })
    expect(mixed.requests[1]!.messages[1]).not.toHaveProperty('source.replayState')
  })

  it('uses the default model effort and reports non-Error failures', async () => {
    const harness = await boot({ defaultEffort: 'max', chunks: async function* () { yield* []; throw 'broken' as never } })
    const result = await harness.post({ sessionId: 'session-1', text: 'x' })
    expect(harness.requests[0]).toMatchObject({ reasoningEffort: 'max' })
    expect(result.body).toContainEqual({ type: 'error', code: 'llm-failed', message: 'broken' })
  })

  it('times out after a slow lookup or a reply that ends past the deadline', async () => {
    const late = await boot({ config: { timeoutMs: 20 }, chunks: request => (async function* () {
      await new Promise((resolve) => { request.signal!.addEventListener('abort', resolve) })
      yield* answer('late')
    })() })
    expect((await late.post({ sessionId: 'session-1', text: 'x' })).body).toContainEqual(expect.objectContaining({ type: 'error', code: 'timeout' }))
    const slowSearch = await boot({
      config: { timeoutMs: 50 },
      subprocess: spec => ({
        done: new Promise((resolve) => { spec.signal!.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }) }),
        collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } },
      }),
      chunks: (_request, round) => (async function* () {
        if (round === 0) yield* lookupCall('c1', 'grep', { pattern: 'x' })
        else yield* answer('never')
      })(),
    })
    // The search root check needs a directory that exists.
    slowSearch.setCwd(process.cwd())
    expect((await slowSearch.post({ sessionId: 'session-1', text: 'x' })).body).toEqual([
      { type: 'start', provider: 'default-p', model: 'default-m' },
      { type: 'step', tool: 'grep', target: 'x' },
      expect.objectContaining({ type: 'error', code: 'timeout' }),
    ])
  })

  it('answers only POST and stops the call when the client disconnects', async () => {
    let seen: AbortSignal | undefined
    const harness = await boot({ chunks: request => (async function* () {
      seen = request.signal
      await new Promise((_resolve, reject) => { request.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }) })
      yield* answer('late')
    })() })
    expect((await harness.get()).status).toBe(405)
    const controller = new AbortController()
    const pending = harness.post({ sessionId: 'session-1', text: 'x' }, undefined, controller.signal).catch(() => 'aborted')
    await expect.poll(() => seen).toBeDefined()
    controller.abort()
    expect(await pending).toBe('aborted')
    await expect.poll(() => seen!.aborted).toBe(true)
  })

  it('requires provider and model together', () => {
    expect(() => { apply({} as Context, { ...CONFIG, provider: 'p' }) }).toThrow(/together/)
  })
})
