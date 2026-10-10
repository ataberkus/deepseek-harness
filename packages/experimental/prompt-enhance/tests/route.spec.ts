import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

const CONFIG = {
  maxDraftChars: 100, historyMessages: 2, historyMessageChars: 50,
  maxOutputTokens: 200, timeoutMs: 5_000, maxConcurrent: 1,
} satisfies Config

const answer = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface Harness {
  readonly post: (body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>
  readonly requests: GenerateOptions[]
}

async function boot(options: {
  config?: Partial<Config>
  chunks?: (request: GenerateOptions) => AsyncIterable<StreamChunk>
  rejection?: 401 | 403
  pending?: { provider: string; model: string; reasoningEffort?: string }
} = {}): Promise<Harness> {
  let handler: Handler | undefined
  const requests: GenerateOptions[] = []
  const session = {
    header: { cwd: '/repo' },
    deriveMessages: () => [],
  }
  const ctx = {
    effect: (fn: () => unknown) => { fn() },
    webServer: { register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => options.rejection },
    agents: { get: (id: string) => id === 'session-1' ? { session } : undefined },
    llm: {
      stream: (request: GenerateOptions) => {
        requests.push(request)
        return options.chunks?.(request) ?? (async function* () { yield* answer('```\nRewritten prompt\n```') })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-p', model: 'default-m' }) },
    get: (name: string) => name === 'sessionProjections' && options.pending !== undefined
      ? { stateOf: () => ({ pending: options.pending, lastUsed: null }) }
      : undefined,
    logger: { warn: () => {} },
  }
  // The stub carries only the services the route reads.
  apply(ctx as never, { ...CONFIG, ...options.config })
  const server = createServer((req, res) => { void handler!(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    requests,
    post: async (body, headers = { 'content-type': 'application/json' }) => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/prompt-enhance`, {
        method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      const text = await response.text()
      const parsed: unknown = text === '' ? undefined : JSON.parse(text)
      return { status: response.status, body: parsed }
    },
  }
}

describe('prompt-enhance route', () => {
  it('rewrites the draft with the default model and strips the fence', async () => {
    const harness = await boot()
    const result = await harness.post({ sessionId: 'session-1', text: 'fix it' })
    expect(result).toEqual({ status: 200, body: { text: 'Rewritten prompt', provider: 'default-p', model: 'default-m' } })
    const [request] = harness.requests
    expect(request).toMatchObject({ provider: 'default-p', model: 'default-m', maxTokens: 200 })
    expect(request!.messages[0]!.content).toEqual([{ type: 'text', text: '<workspace>/repo</workspace>\n<draft>\nfix it\n</draft>' }])
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
    expect((await harness.post({ sessionId: 'session-1', text: 'x'.repeat(101) })).status).toBe(413)
    expect(await harness.post({ sessionId: 'missing', text: 'x' })).toMatchObject({ status: 404, body: { code: 'session-not-found' } })
    expect(harness.requests).toEqual([])
  })

  it('answers the connection fence first', async () => {
    const harness = await boot({ rejection: 401 })
    expect((await harness.post({ sessionId: 'session-1', text: 'x' })).status).toBe(401)
  })

  it('reports model failures and empty answers', async () => {
    const failing = await boot({ chunks: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'auth', message: 'no key' } } }
    } })
    expect(await failing.post({ sessionId: 'session-1', text: 'x' })).toEqual({ status: 502, body: { code: 'auth', message: 'no key' } })
    const empty = await boot({ chunks: async function* () { yield* answer('```') } })
    expect(await empty.post({ sessionId: 'session-1', text: 'x' })).toMatchObject({ status: 502, body: { code: 'empty' } })
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

  it('requires provider and model together', () => {
    expect(() => { apply({} as Context, { ...CONFIG, provider: 'p' }) }).toThrow(/together/)
  })
})
