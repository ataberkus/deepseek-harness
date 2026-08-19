/** Cursor poll, protobuf, Connect, listing, and streamSimple fixtures — never a live Cursor API. */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, Context as PiContext, Model, Tool } from '@earendil-works/pi-ai'
import { CURSOR_API, CURSOR_PROVIDER } from '../src/cursor/constants.ts'
import {
  connectStream,
  connectUnary,
  cursorConnectInternals,
  decodeConnectFrames,
  frameConnectMessage,
} from '../src/cursor/connect.ts'
import { cursorModel, cursorListingInternals, decodeUsableModels, encodeUsableModelsRequest, listCursorModels } from '../src/cursor/models.ts'
import { cursorPricingForModel } from '../src/cursor/pricing.ts'
import {
  generateCursorAuthParams,
  cursorOAuthInternals,
  pollCursorAuth,
  refreshCursorToken,
  tokenExpiry,
} from '../src/cursor/oauth.ts'
import { createCursorProvider, cursorProvider, loginCursor, refreshCursor, toCursorAuth } from '../src/cursor/provider.ts'
import {
  concat,
  decodeFields,
  encodeBool,
  encodeBytes,
  encodeEmptyMessage,
  encodeMapBytes,
  encodeMessage,
  encodeProtobufValue,
  encodeString,
  encodeVarint,
  fieldMapBytes,
  fieldRepeated,
  fieldString,
  fieldVarint,
} from '../src/cursor/protobuf.ts'
import {
  contextEndsWithToolResult,
  encodeAgentRunRequest,
  encodeMcpArgMap,
  flattenContextText,
  latestTurnText,
  streamMaxMode,
} from '../src/cursor/request.ts'
import { resetCursorSessions, streamCursor } from '../src/cursor/stream.ts'
import { hostedOAuthProvider, hostedOAuthProviders } from '../src/oauth-hosts.ts'
import { FileOAuthStore, OAUTH_CREDENTIALS_FILENAME } from '../src/oauth-store.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const originalConnectRequest = cursorConnectInternals.request
const originalConnect = cursorConnectInternals.connect
const originalListingFetch = cursorListingInternals.fetch
const originalListingNetwork = cursorListingInternals.allowNetwork
const originalOAuthFetch = cursorOAuthInternals.fetch
const originalSleep = cursorOAuthInternals.sleep
const originalUuid = cursorOAuthInternals.randomUUID

afterEach(() => {
  cursorConnectInternals.request = originalConnectRequest
  cursorConnectInternals.connect = originalConnect
  cursorListingInternals.fetch = originalListingFetch
  cursorListingInternals.allowNetwork = originalListingNetwork
  cursorOAuthInternals.fetch = originalOAuthFetch
  cursorOAuthInternals.sleep = originalSleep
  cursorOAuthInternals.randomUUID = originalUuid
  resetCursorSessions()
})

const MODEL: Model<Api> = cursorModel('composer-1.5', 'Composer 1.5', true)

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function interactionUpdate(field: number, payload: Uint8Array): Uint8Array {
  return encodeMessage(1, payload.byteLength === 0 ? encodeEmptyMessage(field) : encodeMessage(field, payload))
}

async function collect(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = []
  for await (const event of stream) types.push(event.type)
  return types
}

describe('hosted OAuth table', () => {
  it('lists openai-codex then cursor', () => {
    expect(hostedOAuthProviders().map(host => host.id)).toEqual(['openai-codex', 'cursor'])
    expect(hostedOAuthProvider('nope')).toBeUndefined()
  })
})

describe('cursor pricing configuration', () => {
  it('carries the optional Teams/Enterprise token rate through resolution', () => {
    expect(resolveProfiles({ cursor: {} }, 0.25).get('cursor')?.cursorTokenRate).toBe(0.25)
  })
})

describe('cursor oauth poll', () => {
  it('opens loginDeepControl and returns tokens after a pending 404', async () => {
    cursorOAuthInternals.randomUUID = () => 'pair-id'
    cursorOAuthInternals.sleep = async () => undefined
    const responses = [
      { status: 404, ok: false, json: async () => ({}) },
      {
        status: 200,
        ok: true,
        json: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      },
    ]
    cursorOAuthInternals.fetch = vi.fn(async () => responses.shift() as Response)
    const params = await generateCursorAuthParams()
    expect(params.loginUrl).toContain('challenge=')
    expect(params.loginUrl).toContain('uuid=pair-id')
    expect(params.loginUrl).toContain('redirectTarget=cli')
    await expect(pollCursorAuth(params.uuid, params.verifier)).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    })
  })

  it('aborts the poll when the signal fires', async () => {
    const ac = new AbortController()
    cursorOAuthInternals.sleep = async (_ms, signal) => {
      ac.abort()
      if (signal?.aborted) throw new Error('Cursor authentication polling aborted')
    }
    cursorOAuthInternals.fetch = vi.fn()
    await expect(pollCursorAuth('u', 'v', ac.signal)).rejects.toThrow(/aborted/)
  })

  it('stops after consecutive poll errors', async () => {
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => {
      throw new Error('network')
    })
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/Too many consecutive errors/)
  })

  it('refuses a poll reply without a refresh token', async () => {
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ accessToken: 'access' }),
    }) as Response)
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/no refresh token/)
  })

  it('refuses invalid token JSON', async () => {
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => null,
    }) as Response)
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/invalid token response/)
  })

  it('refuses a missing access token and an invalid refresh token', async () => {
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ accessToken: '', refreshToken: 1 }),
    }) as Response)
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/no access token/)
    cursorOAuthInternals.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ accessToken: 'a', refreshToken: 1 }),
    }) as Response)
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/invalid refresh token/)
  })

  it('counts a non-404 HTTP error toward consecutive failures', async () => {
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => ({ status: 500, ok: false }) as Response)
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/Too many consecutive errors/)
  })

  it('times out after the poll attempt limit', async () => {
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => ({ status: 404, ok: false }) as Response)
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/timeout/)
  })

  it('refreshes and keeps the previous refresh token when the reply omits one', async () => {
    cursorOAuthInternals.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ accessToken: 'next' }),
    }) as Response)
    await expect(refreshCursorToken('old-refresh')).resolves.toMatchObject({
      type: 'oauth',
      access: 'next',
      refresh: 'old-refresh',
    })
  })

  it('fails a non-OK refresh', async () => {
    cursorOAuthInternals.fetch = vi.fn(async () => ({ status: 401, ok: false }) as Response)
    await expect(refreshCursorToken('old-refresh')).rejects.toThrow(/refresh failed: 401/)
  })

  it('reads JWT expiry and falls back when the token is not a JWT', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
    expect(tokenExpiry(`h.${payload}.s`)).toBe(exp * 1000 - 5 * 60 * 1000)
    expect(tokenExpiry('not-a-jwt')).toBeGreaterThan(Date.now())
    const bad = Buffer.from('not-json').toString('base64url')
    expect(tokenExpiry(`h.${bad}.s`)).toBeGreaterThan(Date.now())
    const noExp = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')
    expect(tokenExpiry(`h.${noExp}.s`)).toBeGreaterThan(Date.now())
  })

  it('sleeps, aborts an in-flight delay, and refuses an already-aborted wait', async () => {
    await cursorOAuthInternals.sleep(0)
    const done = new AbortController()
    done.abort()
    await expect(cursorOAuthInternals.sleep(1, done.signal)).rejects.toThrow(/aborted/)
    const live = new AbortController()
    const pending = cursorOAuthInternals.sleep(60_000, live.signal)
    live.abort()
    await expect(pending).rejects.toThrow(/aborted/)
  })

  it('wraps a fetch failure after the caller aborts as a poll abort', async () => {
    const ac = new AbortController()
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => {
      ac.abort()
      throw new Error('socket')
    })
    await expect(pollCursorAuth('u', 'v', ac.signal)).rejects.toThrow(/aborted/)
  })

  it('uses the process fetch default when internals.fetch is not replaced', async () => {
    cursorOAuthInternals.sleep = async () => undefined
    const stub = vi.fn(async () => ({ status: 404, ok: false }) as Response)
    vi.stubGlobal('fetch', stub)
    await expect(pollCursorAuth('u', 'v')).rejects.toThrow(/timeout/)
    expect(stub).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('cursor protobuf', () => {
  it('round-trips strings, bools, maps, and JSON values', () => {
    const encoded = concat(
      encodeString(1, 'name'),
      encodeBool(2, true),
      encodeBool(3, false),
      encodeMapBytes(4, { k: jsonBytes({ n: 1 }) }),
      encodeEmptyMessage(5),
      encodeProtobufValue(null),
      encodeProtobufValue(1.5),
      encodeProtobufValue('s'),
      encodeProtobufValue(true),
      encodeProtobufValue(false),
      encodeProtobufValue([1, 'x']),
      encodeProtobufValue({ a: 'b' }),
      encodeProtobufValue(undefined),
    )
    const fields = decodeFields(encoded)
    expect(fieldString(fields, 1)).toBe('name')
    expect(fieldVarint(fields, 2)).toBe(1n)
    expect(fieldVarint(fields, 3)).toBeUndefined()
    const map = fieldMapBytes(fields, 4)
    expect(JSON.parse(new TextDecoder().decode(map.get('k')))).toEqual({ n: 1 })
    expect(fieldRepeated(fields, 5)[0]?.byteLength).toBe(0)
  })

  it('skips empty map keys and overruns', () => {
    expect(fieldMapBytes(decodeFields(encodeMessage(1, encodeString(1, ''))), 1).size).toBe(0)
    expect(fieldMapBytes(decodeFields(encodeMessage(1, encodeString(1, 'k'))), 1).size).toBe(0)
    expect(() => decodeFields(Uint8Array.of(0x08))).toThrow(/varint overruns/)
    expect(() => decodeFields(encodeVarint((1 << 3) | 3))).toThrow(/wire type 3/)
  })

  it('skips fixed32 and fixed64 fields', () => {
    const fixed64 = concat(encodeVarint((1 << 3) | 1), new Uint8Array(8))
    const fixed32 = concat(encodeVarint((2 << 3) | 5), new Uint8Array(4))
    expect(decodeFields(concat(fixed64, encodeString(3, 'ok'), fixed32))[1]?.field).toBe(3)
    expect(() => decodeFields(concat(encodeVarint((1 << 3) | 1), new Uint8Array(2)))).toThrow(/fixed64/)
    expect(() => decodeFields(concat(encodeVarint((1 << 3) | 5), new Uint8Array(1)))).toThrow(/fixed32/)
  })

  it('refuses a negative varint and a too-long varint', () => {
    expect(encodeVarint(300n).byteLength).toBeGreaterThan(1)
    expect(encodeVarint(300).byteLength).toBeGreaterThan(1)
    expect(() => encodeVarint(-1)).toThrow(/non-negative/)
    const long = new Uint8Array(11).fill(0x80)
    expect(() => decodeFields(concat(encodeVarint(8), long))).toThrow(/too long/)
  })

  it('refuses a length-delimited overrun', () => {
    expect(() => decodeFields(concat(encodeVarint((1 << 3) | 2), encodeVarint(4), Uint8Array.of(1)))).toThrow(/overruns/)
  })
})

describe('cursor connect', () => {
  it('frames and decodes data frames while ignoring trailers', () => {
    const payload = encodeString(1, 'hi')
    const framed = concat(frameConnectMessage(payload), Uint8Array.of(0x02, 0, 0, 0, 0))
    expect(decodeConnectFrames(framed)).toEqual([{ payload }])
    expect(decodeConnectFrames(framed.subarray(0, 3))).toEqual([])
  })

  it('reads a unary Connect reply and raw bytes when unframed', async () => {
    const payload = encodeString(1, 'models')
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(payload)
    }
    await expect(connectUnary({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })).resolves.toEqual(payload)
    cursorConnectInternals.request = async function* () {
      yield payload
    }
    await expect(connectUnary({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })).resolves.toEqual(payload)
  })

  it('streams incremental Connect frames and enforces the size ceiling', async () => {
    const first = encodeString(1, 'a')
    const second = encodeString(1, 'b')
    const framed = concat(frameConnectMessage(first), frameConnectMessage(second))
    cursorConnectInternals.request = async function* () {
      yield framed.subarray(0, 3)
      yield framed.subarray(3)
    }
    const payloads: Uint8Array[] = []
    for await (const chunk of connectStream({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })) payloads.push(chunk)
    expect(payloads).toEqual([first, second])
    cursorConnectInternals.request = async function* () {
      yield framed.subarray(0, 6)
      yield framed.subarray(6)
    }
    const splitHeader: Uint8Array[] = []
    for await (const chunk of connectStream({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })) splitHeader.push(chunk)
    expect(splitHeader.length).toBeGreaterThan(0)
    cursorConnectInternals.request = async function* () {
      yield concat(frameConnectMessage(first), Uint8Array.of(0x02, 0, 0, 0, 0))
    }
    const withTrailer: Uint8Array[] = []
    for await (const chunk of connectStream({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })) withTrailer.push(chunk)
    expect(withTrailer).toEqual([first])
    cursorConnectInternals.request = async function* () {
      yield concat(frameConnectMessage(first), framed.subarray(0, 2))
      yield framed.subarray(2)
    }
    const leftover: Uint8Array[] = []
    for await (const chunk of connectStream({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })) leftover.push(chunk)
    expect(leftover.length).toBeGreaterThan(0)
    cursorConnectInternals.request = async function* () {
      yield new Uint8Array(33 * 1024 * 1024)
    }
    await expect(async () => {
      for await (const _chunk of connectStream({
        baseUrl: 'https://api2.cursor.sh',
        path: '/x',
        accessToken: 't',
        body: new Uint8Array(),
      })) { /* drain */ }
    }).rejects.toThrow(/size limit/)
  })

  it('refuses a unary reply over the size ceiling', async () => {
    cursorConnectInternals.request = async function* () {
      yield new Uint8Array(5 * 1024 * 1024)
    }
    await expect(connectUnary({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })).rejects.toThrow(/size limit/)
  })

  it('dials through the default HTTP/2 client using an injectable session', async () => {
    const payload = encodeString(1, 'ok')
    const framed = frameConnectMessage(payload)
    const stream = new EventEmitter() as EventEmitter & {
      end: (body: Uint8Array) => void
      close: () => void
    }
    stream.end = () => {
      queueMicrotask(() => {
        stream.emit('data', Buffer.from(framed))
        stream.emit('end')
      })
    }
    stream.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: () => stream,
      close: () => undefined,
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    await expect(connectUnary({
      baseUrl: 'https://api2.cursor.sh/',
      path: '/agent.v1.AgentService/GetUsableModels',
      accessToken: 't',
      body: new Uint8Array(),
    })).resolves.toEqual(payload)
  })

  it('propagates HTTP/2 stream errors and abort', async () => {
    const stream = new EventEmitter() as EventEmitter & {
      end: (body: Uint8Array) => void
      close: () => void
    }
    stream.end = () => {
      queueMicrotask(() => stream.emit('error', new Error('rst')))
    }
    stream.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: () => stream,
      close: () => {
        throw new Error('already closed')
      },
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    await expect(connectUnary({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })).rejects.toThrow(/rst/)

    const hanging = new EventEmitter() as EventEmitter & {
      end: (body: Uint8Array) => void
      close: () => void
    }
    hanging.end = () => undefined
    hanging.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: () => hanging,
      close: () => undefined,
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    const ac = new AbortController()
    const pending = connectUnary({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
      signal: ac.signal,
    })
    ac.abort()
    await expect(pending).rejects.toThrow(/aborted/)
  })

  it('queues HTTP/2 DATA that arrives while another chunk is in flight', async () => {
    const first = encodeString(1, 'a')
    const second = encodeString(1, 'b')
    const stream = new EventEmitter() as EventEmitter & {
      end: (body: Uint8Array) => void
      close: () => void
    }
    stream.end = () => {
      queueMicrotask(() => {
        stream.emit('data', Buffer.from(frameConnectMessage(first)))
        stream.emit('data', Buffer.from(frameConnectMessage(second)))
        stream.emit('end')
      })
    }
    stream.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: () => stream,
      close: () => undefined,
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    await expect(connectUnary({
      baseUrl: 'https://api2.cursor.sh',
      path: '/x',
      accessToken: 't',
      body: new Uint8Array(),
    })).resolves.toEqual(first)
  })
})

describe('cursor models', () => {
  it('uses the dated Cursor rate card and optional team surcharge', () => {
    expect(cursorPricingForModel('grok-4.5')).toEqual({
      input: 2,
      cacheRead: 0.5,
      output: 6,
      cacheWrite: 0,
    })
    expect(cursorPricingForModel('claude-4.6-sonnet', 0.25)).toMatchObject({
      input: 3.25,
      cacheRead: 0.55,
      output: 15.25,
    })
    expect(cursorPricingForModel('composer-unknown')).toBeUndefined()
  })

  it('decodes GetUsableModels and overlays live-only ids', async () => {
    const payload = concat(
      encodeMessage(1, concat(encodeString(1, 'composer-1.5'), encodeString(4, 'Composer 1.5'), encodeEmptyMessage(2))),
      encodeMessage(1, concat(encodeString(1, 'live-only'), encodeString(3, 'Live'), encodeString(4, ''))),
      encodeMessage(1, encodeString(1, '')),
      encodeMessage(1, encodeString(1, 'composer-1.5')),
    )
    const decoded = decodeUsableModels(payload)
    expect(decoded.map(model => model.id)).toEqual(['composer-1.5', 'live-only'])
    expect(decodeUsableModels(encodeMessage(1, encodeString(1, 'id-only')))[0]?.name).toBe('id-only')
    cursorListingInternals.fetch = async () => payload
    const listed = await listCursorModels('token')
    expect(listed.map(model => model.id)).toContain('live-only')
    expect(listed.map(model => model.id)).toContain('composer-1.5')
  })

  it('keeps the fallback when listing is empty or throws', async () => {
    cursorListingInternals.fetch = async () => new Uint8Array()
    const empty = await listCursorModels('token')
    expect(empty.length).toBeGreaterThan(0)
    cursorListingInternals.fetch = async () => {
      throw new Error('down')
    }
    await expect(listCursorModels('token')).resolves.toEqual(empty)
  })

  it('encodes a GetUsableModels request and infers context windows', () => {
    expect(encodeUsableModelsRequest(['a', 'b']).byteLength).toBeGreaterThan(0)
    expect(encodeUsableModelsRequest().byteLength).toBe(0)
    expect(decodeUsableModels(encodeMessage(1, concat(
      encodeString(1, 'big'),
      encodeString(4, '1M context'),
    )))[0]?.contextWindow).toBe(1_000_000)
    expect(decodeUsableModels(encodeMessage(1, concat(
      encodeString(1, 'g'),
      encodeString(4, '256k'),
    )))[0]?.contextWindow).toBe(256_000)
    expect(decodeUsableModels(encodeMessage(1, concat(
      encodeString(1, 'g'),
      encodeString(4, '272k'),
    )))[0]?.contextWindow).toBe(272_000)
    expect(cursorModel('plain', 'Plain', false).contextWindow).toBe(200_000)
  })

  it('skips live GetUsableModels when network listing is disabled', async () => {
    const listed = await listCursorModels('token')
    expect(listed.map(model => model.id)).toContain('composer-1.5')
    expect(listed.map(model => model.id)).not.toContain('live-only')
  })

  it('lists through the default GetUsableModels fetch when network listing is allowed', async () => {
    cursorListingInternals.allowNetwork = true
    const payload = encodeMessage(1, concat(encodeString(1, 'live-only'), encodeString(4, 'Live')))
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(payload)
    }
    const listed = await listCursorModels('token')
    expect(listed.map(model => model.id)).toContain('live-only')
    expect((await listCursorModels('token', AbortSignal.timeout(1_000))).map(model => model.id)).toContain('live-only')
  })
})

describe('cursor request encoding', () => {
  const tools: Tool[] = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
  const context: PiContext = {
    systemPrompt: 'sys',
    messages: [
      { role: 'user', content: 'hi', timestamp: 0 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'thinking', thinking: 'hmm' },
          { type: 'toolCall', id: '1', name: 'bash', arguments: { command: 'ls' } },
        ],
        api: CURSOR_API,
        provider: CURSOR_PROVIDER,
        model: 'composer-1.5',
        usage: ZERO_USAGE,
        stopReason: 'toolUse',
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: '1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'out' }],
        isError: false,
        timestamp: 0,
      },
    ],
    tools,
  }

  it('flattens history and encodes MCP tools', () => {
    expect(flattenContextText(context)).toContain('hi')
    expect(flattenContextText(context)).toContain('bash:')
    expect(contextEndsWithToolResult(context)).toBe(true)
    expect(latestTurnText(context)).toContain('bash:')
    expect(latestTurnText({ messages: [{ role: 'user', content: 'next', timestamp: 0 }] })).toBe('next')
    expect(latestTurnText({ messages: [] })).toBe('')
    expect(streamMaxMode({ reasoning: 'max' })).toBe(true)
    expect(streamMaxMode({ reasoning: 'xhigh' })).toBe(true)
    expect(streamMaxMode({ reasoning: 'low' })).toBe(false)
    expect(streamMaxMode(undefined)).toBe(false)
    expect(fieldString(decodeFields(encodeAgentRunRequest({
      conversationId: 'c',
      userText: 'hi',
      modelId: 'composer-1.5',
    })), 5)).toBe('c')
    const encoded = encodeAgentRunRequest({
      conversationId: 'conv',
      checkpoint: Uint8Array.of(1, 2, 3),
      userText: 'hello',
      systemPrompt: 'sys',
      modelId: 'composer-1.5',
      tools,
      maxMode: true,
      thinking: true,
    })
    expect(fieldString(decodeFields(encoded), 5)).toBe('conv')
    expect(encodeMcpArgMap({ command: 'ls' }).byteLength).toBeGreaterThan(0)
  })

  it('flattens image placeholders and empty tool results', () => {
    expect(flattenContextText({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'abc', mimeType: 'image/png' }],
        timestamp: 0,
      }],
    })).toContain('[image]')
    expect(latestTurnText({
      messages: [{
        role: 'toolResult',
        toolCallId: '1',
        toolName: 'bash',
        content: [],
        isError: false,
        timestamp: 0,
      }],
    })).toContain('(no output)')
    expect(flattenContextText({
      messages: [{
        role: 'toolResult',
        toolCallId: '1',
        toolName: 'bash',
        content: [],
        isError: false,
        timestamp: 0,
      }],
    })).toContain('(no output)')
    expect(flattenContextText({
      messages: [{ role: 'user', content: [{ type: 'unknown' }] as never, timestamp: 0 }],
    })).toBe('')
    expect(latestTurnText({
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        api: CURSOR_API,
        provider: CURSOR_PROVIDER,
        model: 'm',
        usage: ZERO_USAGE,
        stopReason: 'stop',
        timestamp: 0,
      }],
    })).toContain('x')
    expect(flattenContextText({
      messages: [
        {
          role: 'assistant',
          content: [],
          api: CURSOR_API,
          provider: CURSOR_PROVIDER,
          model: 'm',
          usage: ZERO_USAGE,
          stopReason: 'stop',
          timestamp: 0,
        },
        { role: 'user', content: [{ type: 'text' }] as never, timestamp: 0 },
      ],
    })).toBe('')
  })
})

describe('cursor streamSimple', () => {
  it('accounts for tokenDelta output and approximate serialized input', async () => {
    const model = cursorModel('grok-4.5', 'Grok 4.5', true)
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(8, concat(encodeVarint(8), encodeVarint(7))))
      yield frameConnectMessage(interactionUpdate(14, encodeEmptyMessage(14)))
    }
    const events: { type: string; message?: { usage?: { input: number; output: number; cost: { total: number } } } }[] = []
    for await (const event of streamCursor(model, {
      messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' }, sessionId: 'cost-session' })) {
      events.push(event as typeof events[number])
    }
    const done = events.find(event => event.type === 'done')
    expect(done?.message?.usage).toMatchObject({ output: 7 })
    expect(done?.message?.usage?.input).toBeGreaterThan(0)
    expect(done?.message?.usage?.cost.total).toBeGreaterThan(0)
  })

  it('maps text, thinking, MCP tools, and ignores native exec', async () => {
    const mcp = encodeMessage(15, encodeMessage(1, concat(
      encodeString(1, 'bash'),
      encodeMapBytes(2, { command: jsonBytes('ls') }),
      encodeString(3, 'call-1'),
    )))
    const native = encodeMessage(1, encodeString(1, 'echo'))
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(4, encodeString(1, 'think')))
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, 'hello')))
      yield frameConnectMessage(encodeBytes(3, Uint8Array.of(9)))
      yield frameConnectMessage(encodeMessage(2, encodeString(1, 'exec')))
      yield frameConnectMessage(interactionUpdate(2, concat(
        encodeString(1, 'call-native'),
        encodeMessage(2, native),
      )))
      yield frameConnectMessage(interactionUpdate(2, concat(
        encodeString(1, 'call-1'),
        encodeMessage(2, mcp),
      )))
      yield frameConnectMessage(interactionUpdate(3, concat(
        encodeString(1, 'call-1'),
        encodeMessage(2, mcp),
      )))
      yield frameConnectMessage(interactionUpdate(2, concat(
        encodeString(1, 'call-1'),
        encodeMessage(2, encodeMessage(15, encodeMessage(1, encodeString(1, 'bash')))),
      )))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    const types = await collect(streamCursor({ ...MODEL, baseUrl: '' }, {
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
    }, { headers: { 'x-other': '1', authorization: 'Bearer tok' }, sessionId: 's1' }))
    expect(types).toContain('thinking_delta')
    expect(types).toContain('text_delta')
    expect(types).toContain('toolcall_end')
    expect(types.at(-1)).toBe('done')
  })

  it('reuses a checkpoint for a later user turn and flattens tool results', async () => {
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(encodeBytes(3, Uint8Array.of(1, 2)))
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, 'ok')))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'one', timestamp: 0 }],
    }, { headers: { Authorization: 'Bearer tok' }, sessionId: 's2' }))
    let captured: Uint8Array | undefined
    cursorConnectInternals.request = async function* (request) {
      captured = request.body
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, 'two')))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    await collect(streamCursor(MODEL, {
      messages: [
        { role: 'user', content: 'one', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          api: CURSOR_API,
          provider: CURSOR_PROVIDER,
          model: MODEL.id,
          usage: ZERO_USAGE,
          stopReason: 'stop',
          timestamp: 0,
        },
        { role: 'user', content: 'two', timestamp: 0 },
      ],
    }, { headers: { authorization: 'Bearer tok' }, sessionId: 's2' }))
    expect(fieldRepeated(decodeFields(captured ?? new Uint8Array()), 1)[0]).toEqual(Uint8Array.of(1, 2))
    const action = fieldRepeated(decodeFields(captured ?? new Uint8Array()), 2)[0]
    const user = action === undefined ? undefined : fieldRepeated(decodeFields(action), 1)[0]
    expect(user === undefined ? '' : fieldString(decodeFields(user), 1)).toBe('two')
  })

  it('maps partial MCP args and missing-token errors', async () => {
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(7, concat(
        encodeString(1, 'p1'),
        encodeString(3, '{"x":'),
      )))
      yield frameConnectMessage(interactionUpdate(7, concat(
        encodeString(1, 'p1'),
        encodeString(3, '1}'),
      )))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    const types = await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { apiKey: 'tok' }))
    expect(types).toContain('toolcall_end')
    const missing = streamCursor(MODEL, { messages: [] }, {})
    const events = []
    for await (const event of missing) events.push(event)
    expect(events.some(event => event.type === 'error')).toBe(true)
  })

  it('aborts an in-flight stream and wraps transport failures', async () => {
    const ac = new AbortController()
    cursorConnectInternals.request = async function* () {
      ac.abort()
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, 'x')))
    }
    const aborted = []
    for await (const event of streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' }, signal: ac.signal })) {
      aborted.push(event.type)
    }
    expect(aborted).toContain('error')
    cursorConnectInternals.request = async function* () {
      throw 'dial failed'
    }
    const failed = []
    for await (const event of streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' } })) {
      failed.push(event)
    }
    expect(failed.some(event => event.type === 'error')).toBe(true)
  })

  it('treats a pre-aborted signal as aborted and skips empty deltas', async () => {
    const ac = new AbortController()
    ac.abort()
    const events = []
    for await (const event of streamCursor(MODEL, { messages: [] }, {
      headers: { authorization: 'Bearer tok' },
      signal: ac.signal,
    })) events.push(event.type)
    expect(events).toEqual(['error'])
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, '')))
      yield frameConnectMessage(interactionUpdate(4, encodeString(1, '')))
      yield frameConnectMessage(interactionUpdate(8, encodeString(1, 'token')))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    const types = await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: '  ' }, apiKey: ' tok ' }))
    expect(types.at(-1)).toBe('done')
  })

  it('flattens the next turn after a tool-use checkpoint instead of replaying it', async () => {
    const mcp = encodeMessage(15, encodeMessage(1, concat(
      encodeString(1, 'bash'),
      encodeMapBytes(2, { command: jsonBytes('ls') }),
      encodeString(3, 'call-1'),
    )))
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(encodeBytes(3, Uint8Array.of(7)))
      yield frameConnectMessage(interactionUpdate(2, concat(
        encodeString(1, 'call-1'),
        encodeMessage(2, mcp),
      )))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'run', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' }, sessionId: 'tools' }))
    let captured: Uint8Array | undefined
    cursorConnectInternals.request = async function* (request) {
      captured = request.body
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, 'done')))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    await collect(streamCursor(MODEL, {
      messages: [
        { role: 'user', content: 'run', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }],
          api: CURSOR_API,
          provider: CURSOR_PROVIDER,
          model: MODEL.id,
          usage: ZERO_USAGE,
          stopReason: 'toolUse',
          timestamp: 0,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 0,
        },
      ],
    }, { headers: { authorization: 'Bearer tok' }, sessionId: 'tools' }))
    expect(fieldRepeated(decodeFields(captured ?? new Uint8Array()), 1)[0]).toBeUndefined()
  })

  it('recovers non-JSON MCP arg bytes and skips an MCP tool with no name', async () => {
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(2, concat(
        encodeString(1, 'anon'),
        encodeMessage(2, encodeMessage(15, encodeMessage(1, concat(
          encodeString(1, ''),
          encodeMapBytes(2, { raw: new TextEncoder().encode('not-json') }),
        )))),
      )))
      yield frameConnectMessage(interactionUpdate(2, concat(
        encodeString(1, 'ok'),
        encodeMessage(2, encodeMessage(15, encodeMessage(1, concat(
          encodeString(1, 'bash'),
          encodeMapBytes(2, { raw: new TextEncoder().encode('not-json') }),
          encodeString(3, 'ok'),
        )))),
      )))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    const types = await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' } }))
    expect(types).toContain('toolcall_end')
  })

  it('aborts after the transport finishes and when connect throws under abort', async () => {
    const after = new AbortController()
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, 'x')))
      after.abort()
    }
    const finished = []
    for await (const event of streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'tok' }, signal: after.signal })) {
      finished.push(event.type)
    }
    expect(finished).toContain('error')

    const thrown = new AbortController()
    cursorConnectInternals.request = async function* () {
      thrown.abort()
      throw new Error('dial failed')
    }
    const failed = []
    for await (const event of streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' }, signal: thrown.signal })) {
      failed.push(event.type)
    }
    expect(failed).toContain('error')
  })

  it('accumulates a non-object partial JSON payload as raw arguments', async () => {
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(7, concat(
        encodeString(1, 'p2'),
        encodeString(3, '[1]'),
      )))
      yield frameConnectMessage(interactionUpdate(7, encodeString(3, '{"x":1}')))
      yield frameConnectMessage(interactionUpdate(2, concat(
        encodeString(1, 'no-args'),
        encodeMessage(2, encodeBytes(15, new Uint8Array())),
      )))
      yield frameConnectMessage(interactionUpdate(2, encodeMessage(2, encodeMessage(15, encodeMessage(1, encodeString(1, 'anon'))))))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    const types = await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' } }))
    expect(types).toContain('toolcall_end')
  })
})

describe('cursor provider', () => {
  it('memoizes the hosted provider and implements OAuth auth', async () => {
    expect(cursorProvider()).toBe(cursorProvider())
    expect(cursorProvider().auth.apiKey).toBeUndefined()
    cursorOAuthInternals.sleep = async () => undefined
    cursorOAuthInternals.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ accessToken: 'a', refreshToken: 'r' }),
    }) as Response)
    const opened: string[] = []
    const credential = await loginCursor({
      prompt: async () => {
        throw new Error('cursor login must not prompt')
      },
      notify: (event) => {
        if (event.type === 'auth_url') opened.push(event.url)
      },
    })
    expect(opened[0]).toContain('loginDeepControl')
    expect(credential.type).toBe('oauth')
    cursorOAuthInternals.fetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ accessToken: 'b', refreshToken: 'r2' }),
    }) as Response)
    await expect(refreshCursor(credential)).resolves.toMatchObject({ access: 'b', refresh: 'r2' })
    await expect(toCursorAuth(credential)).resolves.toEqual({
      headers: { authorization: `Bearer ${credential.access}` },
    })
    expect(createCursorProvider().id).toBe(CURSOR_PROVIDER)
    expect(createCursorProvider()).not.toBe(cursorProvider())
  })
})

describe('cursor adapter listing', () => {
  it('overlays GetUsableModels onto the fallback catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-list-'))
    const store = new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
    await store.modify('cursor', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    cursorListingInternals.fetch = async () => encodeMessage(1, concat(
      encodeString(1, 'live-only'),
      encodeString(4, 'Live Only'),
    ))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ cursor: {} }),
      resolveApiKey: async () => undefined,
      credentials: store,
    })
    const models = await adapter.listModels('cursor')
    expect(models.map(model => model.id)).toContain('live-only')
    expect(models.map(model => model.id)).toContain('composer-1.5')
  })

  it('keeps the fallback when no access token is stored', async () => {
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ cursor: {} }),
      resolveApiKey: async () => undefined,
    })
    const models = await adapter.listModels('cursor')
    expect(models.map(model => model.id)).toContain('composer-1.5')
    expect(models.map(model => model.id)).not.toContain('live-only')
  })

  it('ignores a stored cursor credential with a blank access token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-empty-'))
    const store = new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
    await store.modify('cursor', async () => ({
      type: 'oauth',
      access: '   ',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ cursor: {} }),
      resolveApiKey: async () => undefined,
      credentials: store,
    })
    expect((await adapter.listModels('cursor')).map(model => model.id)).not.toContain('live-only')
  })

  it('ignores a non-oauth stored credential when listing Cursor models', async () => {
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ cursor: {} }),
      resolveApiKey: async () => undefined,
      credentials: {
        read: async () => ({ type: 'api_key', key: 'k' }),
        list: async () => [],
        modify: async () => undefined,
        delete: async () => undefined,
      },
    })
    expect((await adapter.listModels('cursor')).map(model => model.id)).not.toContain('live-only')
  })

  it('keeps an explicit models list off the live overlay', async () => {
    cursorListingInternals.fetch = async () => encodeMessage(1, concat(
      encodeString(1, 'live-only'),
      encodeString(4, 'Live Only'),
    ))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        cursor: { models: [{ id: 'composer-1.5' }] },
      }),
      resolveApiKey: async () => undefined,
    })
    expect((await adapter.listModels('cursor')).map(model => model.id)).toEqual(['composer-1.5'])
  })
})
