/** Cursor poll, protobuf, Connect, listing, and streamSimple fixtures — never a live Cursor API. */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, Context as PiContext, Model, Tool } from '@earendil-works/pi-ai'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import {
  CURSOR_API,
  CURSOR_CLIENT_HEARTBEAT_INTERVAL_MS,
  CURSOR_CLIENT_VERSION,
  CURSOR_PROVIDER,
} from '../src/cursor/constants.ts'
import {
  connectStream,
  connectUnary,
  cursorConnectInternals,
  decodeConnectFrames,
  frameConnectMessage,
} from '../src/cursor/connect.ts'
import {
  cursorModel,
  cursorListingInternals,
  cursorFallbackModels,
  decodeUsableModels,
  encodeUsableModelsRequest,
  listCursorModels,
  mergeCursorCatalogs,
  withFastVariants,
} from '../src/cursor/models.ts'
import {
  generateCursorAuthParams,
  cursorOAuthInternals,
  pollCursorAuth,
  refreshCursorToken,
  tokenExpiry,
} from '../src/cursor/oauth.ts'
import { memoryAuth } from './auth-double.ts'
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
  buildConversationTurns,
  buildRootPromptMessagesJson,
  collectContextImages,
  contextEndsWithToolResult,
  createBlobId,
  encodeAgentRunClientMessage,
  encodeAgentRunRequest,
  encodeAllowlistPrecheckResponse,
  encodeCursorClientHeartbeat,
  encodeCursorInteractionResponse,
  encodeCursorRule,
  encodeExecStreamClose,
  encodeExecThrowResponse,
  encodeKvGetBlobResponse,
  encodeKvSetBlobResponse,
  encodeMcpArgMap,
  encodeMcpToolDefinitions,
  encodeRequestContextResponse,
  flattenContextText,
  latestTurnText,
  storeBlob,
  streamMaxMode,
} from '../src/cursor/request.ts'
import { resetCursorSessions, streamCursor } from '../src/cursor/stream.ts'
import { toStreamChunks } from '../src/stream.ts'
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

function runRequestPayload(body: Uint8Array | undefined): Uint8Array {
  return fieldRepeated(decodeFields(body ?? new Uint8Array()), 1)[0] ?? new Uint8Array()
}

async function collect(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = []
  for await (const event of stream) types.push(event.type)
  return types
}

describe('hosted OAuth table', () => {
  it('lists openai-codex then cursor then google-antigravity', () => {
    expect(hostedOAuthProviders().map(host => host.id)).toEqual([
      'openai-codex',
      'cursor',
      'google-antigravity',
    ])
    expect(hostedOAuthProvider('nope')).toBeUndefined()
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
    const requestBody = encodeString(1, 'request')
    const framed = frameConnectMessage(payload)
    const stream = new EventEmitter() as EventEmitter & {
      end: (body: Uint8Array) => void
      close: () => void
    }
    let sentBody: Uint8Array | undefined
    let sentHeaders: Record<string, unknown> | undefined
    stream.end = (body) => {
      sentBody = body
      queueMicrotask(() => {
        stream.emit('response', { ':status': 200 })
        stream.emit('data', Buffer.from(framed))
        stream.emit('end')
      })
    }
    stream.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: (headers: Record<string, unknown>) => {
        sentHeaders = headers
        return stream
      },
      close: () => undefined,
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    await expect(connectUnary({
      baseUrl: 'https://api2.cursor.sh/',
      path: '/agent.v1.AgentService/GetUsableModels',
      accessToken: 't',
      body: requestBody,
    })).resolves.toEqual(payload)
    expect(sentHeaders).toMatchObject({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/GetUsableModels',
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
      te: 'trailers',
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    })
    expect(sentBody).toEqual(requestBody)
  })

  it('keeps Connect framing for streaming HTTP/2 requests', async () => {
    const payload = encodeString(1, 'response')
    const requestBody = encodeString(1, 'request')
    const stream = new EventEmitter() as EventEmitter & {
      write: (body: Uint8Array) => void
      close: () => void
    }
    const sentBodies: Uint8Array[] = []
    let sentHeaders: Record<string, unknown> | undefined
    stream.write = (body) => {
      sentBodies.push(body)
      if (sentBodies.length !== 1) return
      queueMicrotask(() => {
        stream.emit('response', { ':status': 200 })
        stream.emit('data', Buffer.from(frameConnectMessage(payload)))
        stream.emit('end')
      })
    }
    stream.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: (headers: Record<string, unknown>) => {
        sentHeaders = headers
        return stream
      },
      close: () => undefined,
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    const received: Uint8Array[] = []
    for await (const chunk of connectStream({
      baseUrl: 'https://api2.cursor.sh/',
      path: '/agent.v1.AgentService/Run',
      accessToken: 't',
      body: requestBody,
      onOpen: (send) => { send(encodeCursorClientHeartbeat()) },
    })) received.push(chunk)
    expect(received).toEqual([payload])
    expect(sentBodies).toHaveLength(2)
    expect(sentHeaders).toMatchObject({
      ':path': '/agent.v1.AgentService/Run',
      'content-type': 'application/connect+proto',
      'connect-protocol-version': '1',
      te: 'trailers',
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    })
    expect(sentBodies[0]).toEqual(frameConnectMessage(requestBody))
  })

  it('rejects non-success HTTP/2 responses before decoding their body', async () => {
    const stream = new EventEmitter() as EventEmitter & {
      end: (body: Uint8Array) => void
      close: () => void
    }
    stream.end = () => {
      queueMicrotask(() => {
        stream.emit('response', { ':status': 415 })
        stream.emit('data', Buffer.from('unsupported'))
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
      path: '/agent.v1.AgentService/GetUsableModels',
      accessToken: 't',
      body: new Uint8Array(),
    })).rejects.toThrow('HTTP 415')
  })

  it('rejects nonzero gRPC trailers and tolerates successful trailer metadata', async () => {
    const stream = new EventEmitter() as EventEmitter & {
      end: (body: Uint8Array) => void
      close: () => void
    }
    stream.end = () => {
      queueMicrotask(() => {
        stream.emit('response', {})
        stream.emit('trailers', {})
        stream.emit('trailers', { 'grpc-status': '0' })
        stream.emit('trailers', { 'grpc-status': '8' })
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
    })).rejects.toThrow('gRPC status 8')
  })

  it('reports a client-frame write failure on an open stream', async () => {
    const stream = new EventEmitter() as EventEmitter & {
      write: (body: Uint8Array) => void
      close: () => void
    }
    let writes = 0
    stream.write = () => {
      writes++
      if (writes > 1) throw new Error('client write failed')
      stream.emit('response', { ':status': 200 })
    }
    stream.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: () => stream,
      close: () => undefined,
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    await expect((async () => {
      for await (const _ of connectStream({
        baseUrl: 'https://api2.cursor.sh',
        path: '/agent.v1.AgentService/Run',
        accessToken: 't',
        body: new Uint8Array(),
        onOpen: (send) => {
          send(encodeCursorClientHeartbeat())
          send(encodeCursorClientHeartbeat())
        },
      })) {
        // The write failure ends the stream before a response payload exists.
      }
    })()).rejects.toThrow('client write failed')
  })

  it('normalizes non-Error client-frame write failures', async () => {
    const stream = new EventEmitter() as EventEmitter & {
      write: (body: Uint8Array) => void
      close: () => void
    }
    let writes = 0
    stream.write = () => {
      writes++
      if (writes > 1) throw 'client write failed'
      stream.emit('response', { ':status': 200 })
    }
    stream.close = () => undefined
    cursorConnectInternals.connect = () => ({
      request: () => stream,
      close: () => undefined,
    }) as unknown as ReturnType<typeof cursorConnectInternals.connect>
    await expect((async () => {
      for await (const _ of connectStream({
        baseUrl: 'https://api2.cursor.sh',
        path: '/agent.v1.AgentService/Run',
        accessToken: 't',
        body: new Uint8Array(),
        onOpen: (send) => { send(encodeCursorClientHeartbeat()) },
      })) {
        // The write failure ends the stream before a response payload exists.
      }
    })()).rejects.toThrow('client write failed')
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

  it('rejects a successful empty listing but keeps the fallback on transport failure', async () => {
    cursorListingInternals.fetch = async () => new Uint8Array()
    await expect(listCursorModels('token')).rejects.toMatchObject({
      code: 'CURSOR_NO_USABLE_MODELS',
      message: expect.stringContaining('GetUsableModels') as string,
    })
    cursorListingInternals.fetch = async () => {
      throw new Error('down')
    }
    await expect(listCursorModels('token')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'grok-4.6' }),
      expect.objectContaining({ id: 'grok-4.6-fast' }),
      expect.objectContaining({ id: 'composer-1.5' }),
    ]))
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
    expect(cursorModel('grok-4.6', 'Grok 4.6', true).input).toEqual(['text', 'image'])
    expect(cursorModel('grok-4.6-fast', 'Grok 4.6 Fast', true).input).toEqual(['text', 'image'])
    expect(cursorModel('composer-1.5', 'Composer 1.5', true).input).toEqual(['text', 'image'])
    expect(cursorModel('grok-code', 'Grok Code', false).input).toEqual(['text'])
    expect(cursorModel('live-only', 'Live', false).input).toEqual(['text'])
  })

  it('merges live-first, fills documented Fast SKUs, and infers reasoning', () => {
    const live = [cursorModel('live-only', 'Live', false, 8_000)]
    const fallback = cursorFallbackModels()
    const merged = mergeCursorCatalogs(live, fallback)
    expect(merged[0]?.id).toBe('live-only')
    expect(merged.map(model => model.id)).toEqual(expect.arrayContaining(['grok-4.6', 'grok-4.6-fast']))
    const withFast = withFastVariants([cursorModel('composer-2.5', 'Composer 2.5', true)])
    expect(withFast.map(model => model.id)).toEqual(['composer-2.5', 'composer-2.5-fast'])
    expect(withFastVariants([cursorModel('gpt-5.4', 'GPT-5.4', true, 272_000)]).map(model => model.id))
      .toEqual(['gpt-5.4'])
    expect(decodeUsableModels(encodeMessage(1, concat(
      encodeString(1, 'grok-4.6'),
      encodeString(4, 'Grok 4.6'),
    )))[0]?.reasoning).toBe(true)
    expect(decodeUsableModels(encodeMessage(1, concat(
      encodeString(1, 'grok-code'),
      encodeString(4, 'Grok Code'),
    )))[0]?.reasoning).toBe(false)
    expect(getSupportedThinkingLevels(cursorModel('grok-4.6', 'Grok 4.6', true))).toEqual([
      'low', 'medium', 'high', 'xhigh',
    ])
    expect(cursorModel('grok-4.6', 'Grok 4.6', true)).toMatchObject({
      defaultThinkingLevel: 'high',
      thinkingLevelMap: { off: null, minimal: null, low: 'low', xhigh: 'xhigh' },
    })
    expect(getSupportedThinkingLevels(cursorModel('grok-4.6-fast', 'Grok 4.6 Fast', true))).toEqual([
      'low', 'medium', 'high', 'xhigh',
    ])
    expect(getSupportedThinkingLevels(cursorModel('grok-4.5', 'Grok 4.5', true))).toEqual([
      'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('gpt-5.4', 'GPT-5.4', true))).toEqual([
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh',
    ])
    expect(cursorModel('gpt-5.4', 'GPT-5.4', true).thinkingLevelMap?.off).toBe('none')
    expect(getSupportedThinkingLevels(cursorModel('gpt-5', 'GPT-5', true))).toEqual([
      'off', 'minimal', 'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('claude-4.6-sonnet', 'Sonnet', true))).toEqual([
      'off', 'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('gemini-3-pro', 'Gemini', true))).toEqual([
      'minimal', 'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('composer-2.5', 'Composer', true))).toEqual([
      'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('k3', 'K3', true))).toEqual([
      'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('kimi-k2.5', 'Kimi', true))).toEqual([
      'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('glm-5', 'GLM', true))).toEqual([
      'low', 'high', 'max',
    ])
    expect(getSupportedThinkingLevels(cursorModel('grok-code', 'Grok Code', true))).toEqual([
      'low', 'medium', 'high',
    ])
    expect(getSupportedThinkingLevels(cursorModel('mystery', 'Mystery', true))).toEqual([
      'low', 'medium', 'high',
    ])
    expect(cursorModel('plain', 'Plain', false).thinkingLevelMap).toBeUndefined()
    expect(decodeUsableModels(encodeMessage(1, concat(
      encodeString(1, 'grok-4.6'),
      encodeString(4, 'Grok 4.6'),
    )))[0]?.input).toEqual(['text', 'image'])
    expect(withFastVariants([cursorModel('composer-2.5', 'Composer 2.5', true)])[1]?.input)
      .toEqual(['text', 'image'])
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
    const withEffort = encodeAgentRunRequest({
      conversationId: 'c',
      userText: 'hi',
      modelId: 'grok-4.6',
      thinking: true,
      thinkingEffort: 'xhigh',
    })
    const details = fieldRepeated(decodeFields(withEffort), 3)[0]
    const thinking = details === undefined ? undefined : fieldRepeated(decodeFields(details), 2)[0]
    expect(thinking === undefined ? '' : fieldString(decodeFields(thinking), 1)).toBe('xhigh')
    expect(details === undefined ? '' : fieldString(decodeFields(details), 1)).toBe('cursor-grok-4.6-xhigh')
    expect(details === undefined ? '' : fieldString(decodeFields(details), 3)).toBe('grok-4.6')
    const defaultThinking = encodeAgentRunRequest({
      conversationId: 'c',
      userText: 'hi',
      modelId: 'grok-4.6',
      thinking: true,
    })
    const defaultDetails = fieldRepeated(decodeFields(defaultThinking), 3)[0]
    const emptyThinking = defaultDetails === undefined
      ? undefined
      : fieldRepeated(decodeFields(defaultDetails), 2)[0]
    expect(emptyThinking?.byteLength).toBe(0)
    const offNamed = encodeAgentRunRequest({
      conversationId: 'c',
      userText: 'hi',
      modelId: 'gpt-5',
      thinking: true,
      thinkingEffort: 'off',
    })
    const offDetails = fieldRepeated(decodeFields(offNamed), 3)[0]
    const offThinking = offDetails === undefined ? undefined : fieldRepeated(decodeFields(offDetails), 2)[0]
    expect(offThinking?.byteLength).toBe(0)
    expect(encodeAgentRunRequest({
      conversationId: 'c',
      userText: 'hi',
      modelId: 'gpt-5',
      thinking: false,
      thinkingEffort: 'low',
    }).byteLength).toBeGreaterThan(0)
  })

  it('wraps Run messages and answers supported interaction queries', () => {
    const body = encodeAgentRunClientMessage({
      conversationId: 'c',
      userText: 'hi',
      modelId: 'composer-1.5',
    })
    const outer = decodeFields(body)
    const inner = fieldRepeated(outer, 1)[0]
    expect(inner).toBeDefined()
    expect(fieldString(decodeFields(inner ?? new Uint8Array()), 5)).toBe('c')

    const heartbeat = decodeFields(encodeCursorClientHeartbeat())
    expect(heartbeat).toHaveLength(1)
    expect(heartbeat[0]).toMatchObject({ field: 7, wire: 2 })

    const approved = encodeCursorInteractionResponse(42, 9)
    const response = fieldRepeated(decodeFields(approved ?? new Uint8Array()), 6)[0]
    expect(fieldVarint(decodeFields(response ?? new Uint8Array()), 1)).toBe(42n)
    expect(fieldRepeated(decodeFields(response ?? new Uint8Array()), 9)).toHaveLength(1)
    expect(encodeCursorInteractionResponse(-1, 9)).toBeUndefined()
    expect(encodeCursorInteractionResponse(Number.MAX_SAFE_INTEGER + 1, 9)).toBeUndefined()
    expect(encodeCursorInteractionResponse(42, 3)).toBeDefined()
    expect(encodeCursorInteractionResponse(42, 4)).toBeDefined()
    expect(encodeCursorInteractionResponse(42, 7)).toBeDefined()
    expect(encodeCursorInteractionResponse(42, 8)).toBeUndefined()
  })

  it('encodes selected images and omits image placeholders from flattened text', () => {
    const png = Uint8Array.from(Buffer.from('QQ==', 'base64'))
    expect(flattenContextText({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'QQ==', mimeType: 'image/png' }],
        timestamp: 0,
      }],
    })).toBe('see')
    const collected = collectContextImages({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'QQ==', mimeType: 'image/png' }],
        timestamp: 0,
      }],
    })
    expect(collected).toHaveLength(1)
    expect(collected[0]?.mimeType).toBe('image/png')
    expect(collected[0]?.data).toEqual(png)
    expect(collectContextImages({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'QQ==', mimeType: 'image/png' }],
          timestamp: 0,
        },
        {
          role: 'user',
          content: 'later',
          timestamp: 0,
        },
      ],
    }, true)).toEqual([])
    const encoded = encodeAgentRunRequest({
      conversationId: 'c',
      userText: 'see',
      modelId: 'grok-4.6',
      images: [{
        uuid: 'img-1',
        path: 'img-1.png',
        mimeType: 'image/png',
        data: png,
      }],
    })
    const action = fieldRepeated(decodeFields(encoded), 2)[0]
    const userMessage = fieldRepeated(decodeFields(action ?? new Uint8Array()), 1)[0]
    const selected = fieldRepeated(decodeFields(userMessage ?? new Uint8Array()), 3)[0]
    const image = decodeFields(fieldRepeated(decodeFields(selected ?? new Uint8Array()), 1)[0] ?? new Uint8Array())
    expect(fieldString(image, 2)).toBe('img-1')
    expect(fieldString(image, 3)).toBe('img-1.png')
    expect(fieldString(image, 7)).toBe('image/png')
    expect(fieldRepeated(image, 8)[0]).toEqual(png)
    expect(collectContextImages({
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: '', mimeType: 'image/png' }],
        timestamp: 0,
      }],
    })).toEqual([])
    expect(collectContextImages({
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: 'QQ==', mimeType: 'image/gif' }],
        timestamp: 0,
      }],
    })[0]?.path).toMatch(/\.gif$/)
    expect(collectContextImages({
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: 'QQ==', mimeType: 'image/jpeg' }],
        timestamp: 0,
      }],
    })[0]?.path).toMatch(/\.jpg$/)
    expect(collectContextImages({
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: 'QQ==', mimeType: 'image/jpg' }],
        timestamp: 0,
      }],
    })[0]?.path).toMatch(/\.jpg$/)
    expect(collectContextImages({ messages: [] })).toEqual([])
    expect(collectContextImages({ messages: [] }, true)).toEqual([])
    expect(collectContextImages({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'QQ==', mimeType: 'image/png' }],
          timestamp: 0,
        },
        {
          role: 'toolResult',
          toolCallId: '1',
          toolName: 'bash',
          content: [{ type: 'image', data: 'QQ==', mimeType: 'image/webp' }],
          isError: false,
          timestamp: 0,
        },
      ],
    }, true)).toHaveLength(1)
    expect(collectContextImages({
      messages: [{
        role: 'toolResult',
        toolCallId: '1',
        toolName: 'bash',
        content: [{ type: 'image', data: 'QQ==', mimeType: 'image/webp' }],
        isError: false,
        timestamp: 0,
      }],
    }, true)[0]?.path).toMatch(/\.webp$/)
    expect(collectContextImages({
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'no' }],
        api: CURSOR_API,
        provider: CURSOR_PROVIDER,
        model: 'grok-4.6',
        usage: ZERO_USAGE,
        stopReason: 'stop',
        timestamp: 0,
      }],
    }, true)).toEqual([])
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
  it('sends the selected thinking effort and omits ThinkingDetails when off', async () => {
    let captured: Uint8Array | undefined
    cursorConnectInternals.request = async function* (request) {
      captured = request.body
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    await collect(streamCursor(
      cursorModel('grok-4.6', 'Grok 4.6', true),
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { headers: { authorization: 'Bearer tok' }, reasoning: 'low' },
    ))
    const details = fieldRepeated(decodeFields(runRequestPayload(captured)), 3)[0]
    const thinking = details === undefined ? undefined : fieldRepeated(decodeFields(details), 2)[0]
    expect(thinking === undefined ? '' : fieldString(decodeFields(thinking), 1)).toBe('low')

    captured = undefined
    await collect(streamCursor(
      cursorModel('gpt-5', 'GPT-5', true),
      { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] },
      { headers: { authorization: 'Bearer tok' } },
    ))
    const offDetails = fieldRepeated(decodeFields(runRequestPayload(captured)), 3)[0]
    const offThinking = offDetails === undefined ? undefined : fieldRepeated(decodeFields(offDetails), 2)[0]
    expect(offThinking).toBeUndefined()
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

  it('answers a Cursor interaction query over the open Run stream', async () => {
    const sent: Uint8Array[] = []
    cursorConnectInternals.request = async function* (request) {
      request.onOpen?.((payload) => { sent.push(payload) })
      const query = concat(encodeVarint(8), encodeVarint(7), encodeEmptyMessage(9))
      const vmQuery = concat(encodeVarint(8), encodeVarint(8), encodeEmptyMessage(8))
      const oversizedQuery = concat(
        encodeVarint(8),
        encodeVarint(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        encodeEmptyMessage(9),
      )
      const missingQuery = concat(encodeVarint(8), encodeVarint(9))
      yield frameConnectMessage(encodeMessage(7, query))
      yield frameConnectMessage(encodeMessage(7, vmQuery))
      yield frameConnectMessage(encodeMessage(7, oversizedQuery))
      yield frameConnectMessage(encodeMessage(7, missingQuery))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' } }))
    const response = fieldRepeated(decodeFields(sent[0] ?? new Uint8Array()), 6)[0]
    expect(fieldVarint(decodeFields(response ?? new Uint8Array()), 1)).toBe(7n)
    expect(fieldRepeated(decodeFields(response ?? new Uint8Array()), 9)).toHaveLength(1)
  })

  it('sends client heartbeats while a Run remains open', async () => {
    vi.useFakeTimers()
    try {
      const sent: Uint8Array[] = []
      let release: (() => void) | undefined
      const opened = new Promise<void>((resolve) => {
        cursorConnectInternals.request = async function* (request) {
          request.onOpen?.((payload) => { sent.push(payload) })
          resolve()
          await new Promise<void>((finish) => { release = finish })
          yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
        }
      })
      const completion = collect(streamCursor(MODEL, {
        messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      }, { headers: { authorization: 'Bearer tok' } }))
      await opened
      await vi.advanceTimersByTimeAsync(CURSOR_CLIENT_HEARTBEAT_INTERVAL_MS)
      expect(sent).toHaveLength(1)
      expect(fieldRepeated(decodeFields(sent[0] ?? new Uint8Array()), 7)).toHaveLength(1)
      release?.()
      await completion
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies a heartbeat-only Run as a provider-specific empty stream', async () => {
    cursorConnectInternals.request = async function* () {
      yield frameConnectMessage(interactionUpdate(13, new Uint8Array()))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    const chunks = []
    for await (const chunk of toStreamChunks(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, { headers: { authorization: 'Bearer tok' } }))) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'CURSOR_EMPTY_STREAM',
          message: expect.stringContaining('heartbeat-only') as string,
        },
      },
    })
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
    expect(fieldRepeated(decodeFields(runRequestPayload(captured)), 1)[0]).toEqual(Uint8Array.of(1, 2))
    const action = fieldRepeated(decodeFields(runRequestPayload(captured)), 2)[0]
    const user = action === undefined ? undefined : fieldRepeated(decodeFields(action), 1)[0]
    expect(user === undefined ? '' : fieldString(decodeFields(user), 1)).toBe('two')
  })

  it('sends selected images on a flattened turn', async () => {
    let captured: Uint8Array | undefined
    cursorConnectInternals.request = async function* (request) {
      captured = request.body
      yield frameConnectMessage(interactionUpdate(1, encodeString(1, 'ok')))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }
    await collect(streamCursor(MODEL, {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'QQ==', mimeType: 'image/gif' }],
        timestamp: 0,
      }],
    }, { apiKey: 'tok', sessionId: 'img-turn' }))
    const action = fieldRepeated(decodeFields(runRequestPayload(captured)), 2)[0]
    const userMessage = fieldRepeated(decodeFields(action ?? new Uint8Array()), 1)[0]
    const selected = fieldRepeated(decodeFields(userMessage ?? new Uint8Array()), 3)[0]
    const image = decodeFields(fieldRepeated(decodeFields(selected ?? new Uint8Array()), 1)[0] ?? new Uint8Array())
    expect(fieldString(decodeFields(userMessage ?? new Uint8Array()), 1)).toBe('see')
    expect(fieldString(image, 7)).toBe('image/gif')
    expect(fieldString(image, 3)).toMatch(/\.gif$/)
    expect(fieldRepeated(image, 8)[0]).toEqual(Uint8Array.from(Buffer.from('QQ==', 'base64')))
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
    expect(fieldRepeated(decodeFields(runRequestPayload(captured)), 1)[0]).toBeUndefined()
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
  it('handles kvServerMessage getBlobArgs and setBlobArgs', async () => {
    const sent: Uint8Array[] = []
    const testBlob = new TextEncoder().encode(JSON.stringify({ role: 'system', content: 'hello world' }))
    const blobId = createBlobId(testBlob)
    const missingBlobId = new Uint8Array(32).fill(1)
    const newBlob = new TextEncoder().encode('new content')
    const newBlobId = createBlobId(newBlob)

    cursorConnectInternals.request = async function* (request) {
      request.onOpen?.((payload) => { sent.push(payload) })
      // KvServerMessage 1: get existing blob
      yield frameConnectMessage(encodeMessage(4, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(1),
        encodeMessage(2, encodeBytes(1, blobId)),
      )))
      // KvServerMessage 2: get missing blob
      yield frameConnectMessage(encodeMessage(4, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(2),
        encodeMessage(2, encodeBytes(1, missingBlobId)),
      )))
      // KvServerMessage 3: set blob
      yield frameConnectMessage(encodeMessage(4, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(3),
        encodeMessage(3, concat(encodeBytes(1, newBlobId), encodeBytes(2, newBlob))),
      )))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }

    await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      systemPrompt: 'hello world',
    }, { headers: { authorization: 'Bearer tok' }, sessionId: 'kv-test' }))

    expect(sent.length).toBeGreaterThanOrEqual(3)
    // Verify first response is getBlobResult with blob data
    const getResp = fieldRepeated(decodeFields(sent[0] ?? new Uint8Array()), 3)[0]
    expect(getResp).toBeDefined()
    const getFields = decodeFields(getResp ?? new Uint8Array())
    expect(fieldVarint(getFields, 1)).toBe(1n)
    const resultField = fieldRepeated(getFields, 2)[0]
    expect(resultField).toBeDefined()
    expect(fieldRepeated(decodeFields(resultField ?? new Uint8Array()), 1)[0]).toEqual(testBlob)

    // Verify second response is getBlobResult with empty data (missing)
    const missingResp = fieldRepeated(decodeFields(sent[1] ?? new Uint8Array()), 3)[0]
    const missingFields = decodeFields(missingResp ?? new Uint8Array())
    expect(fieldVarint(missingFields, 1)).toBe(2n)

    // Verify third response is setBlobResult (empty success message)
    const setResp = fieldRepeated(decodeFields(sent[2] ?? new Uint8Array()), 3)[0]
    const setFields = decodeFields(setResp ?? new Uint8Array())
    expect(fieldVarint(setFields, 1)).toBe(3n)
  })

  it('handles execServerMessage requestContextArgs, allowlists, approvals, and unhandled throws', async () => {
    const sent: Uint8Array[] = []
    cursorConnectInternals.request = async function* (request) {
      request.onOpen?.((payload) => { sent.push(payload) })
      // requestContextArgs (10)
      yield frameConnectMessage(encodeMessage(2, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(100),
        encodeString(15, 'exec-1'),
        encodeEmptyMessage(10),
      )))
      // shellAllowlistPrecheckArgs (41)
      yield frameConnectMessage(encodeMessage(2, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(101),
        encodeString(15, 'exec-2'),
        encodeEmptyMessage(41),
      )))
      // mcpAllowlistPrecheckArgs (42)
      yield frameConnectMessage(encodeMessage(2, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(102),
        encodeString(15, 'exec-3'),
        encodeEmptyMessage(42),
      )))
      // webFetchAllowlistPrecheckArgs (43)
      yield frameConnectMessage(encodeMessage(2, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(103),
        encodeString(15, 'exec-4'),
        encodeEmptyMessage(43),
      )))
      // mcpArgs approval probe (11 with smart_mode_approval_only = true)
      yield frameConnectMessage(encodeMessage(2, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(104),
        encodeString(15, 'exec-5'),
        encodeMessage(11, concat(encodeVarint((7 << 3) | 0), encodeVarint(1))),
      )))
      // mcpArgs unapproved tool (11 without approval flag)
      yield frameConnectMessage(encodeMessage(2, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(105),
        encodeString(15, 'exec-6'),
        encodeMessage(11, encodeString(1, 'bash')),
      )))
      // unhandled exec variant (99)
      yield frameConnectMessage(encodeMessage(2, concat(
        encodeVarint((1 << 3) | 0), encodeVarint(106),
        encodeString(15, 'exec-7'),
        encodeEmptyMessage(99),
      )))
      yield frameConnectMessage(interactionUpdate(14, new Uint8Array()))
    }

    await collect(streamCursor(MODEL, {
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      systemPrompt: 'sys rule',
      tools: [{ name: 'bash', description: 'run shell', parameters: { type: 'object' } }],
    }, { headers: { authorization: 'Bearer tok' }, sessionId: 'exec-test' }))

    expect(sent.length).toBeGreaterThanOrEqual(7)
    // Check requestContext response
    const ctxResp = fieldRepeated(decodeFields(sent[0] ?? new Uint8Array()), 2)[0]
    expect(ctxResp).toBeDefined()
    const ctxFields = decodeFields(ctxResp ?? new Uint8Array())
    expect(fieldVarint(ctxFields, 1)).toBe(100n)
    expect(fieldRepeated(ctxFields, 10)).toHaveLength(1)

    // Check precheck responses
    const shellPrecheck = fieldRepeated(decodeFields(sent[1] ?? new Uint8Array()), 2)[0]
    expect(fieldVarint(decodeFields(shellPrecheck ?? new Uint8Array()), 1)).toBe(101n)

    const mcpPrecheck = fieldRepeated(decodeFields(sent[2] ?? new Uint8Array()), 2)[0]
    expect(fieldVarint(decodeFields(mcpPrecheck ?? new Uint8Array()), 1)).toBe(102n)

    const webPrecheck = fieldRepeated(decodeFields(sent[3] ?? new Uint8Array()), 2)[0]
    expect(fieldVarint(decodeFields(webPrecheck ?? new Uint8Array()), 1)).toBe(103n)
  })

  it('builds rootPromptMessagesJson and conversationTurns helper structures', () => {
    const store = new Map<string, Uint8Array>()
    const ctx: PiContext = {
      systemPrompt: 'test prompt',
      messages: [
        { role: 'user', content: 'first', timestamp: 0 },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'assistant reply' },
            { type: 'thinking', thinking: 'thought' },
            { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'pwd' } },
          ],
          api: CURSOR_API,
          provider: CURSOR_PROVIDER,
          model: MODEL.id,
          usage: ZERO_USAGE,
          stopReason: 'toolUse',
          timestamp: 0,
        },
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: '/root' }],
          isError: false,
          timestamp: 0,
        },
        { role: 'user', content: 'second', timestamp: 0 },
      ],
    }
    const rootPromptIds = buildRootPromptMessagesJson(ctx, 3, store)
    expect(rootPromptIds.length).toBeGreaterThan(1)
    expect(store.size).toBeGreaterThan(0)

    const turns = buildConversationTurns(ctx, 3, store)
    expect(turns.length).toBe(1)

    const rule = encodeCursorRule('/test.mdc', 'rule content')
    expect(rule.byteLength).toBeGreaterThan(0)

    const toolDefs = encodeMcpToolDefinitions([{ name: 'test', description: 'desc', parameters: {} }])
    expect(toolDefs.byteLength).toBeGreaterThan(0)

    const testStoredBlob = storeBlob(store, new TextEncoder().encode('stored'))
    expect(testStoredBlob.byteLength).toBe(32)

    const allowlistResp = encodeAllowlistPrecheckResponse(1, 'exec-1', 41)
    expect(allowlistResp.byteLength).toBeGreaterThan(0)

    const getBlobResp = encodeKvGetBlobResponse(1, new Uint8Array([1, 2, 3]))
    expect(getBlobResp.byteLength).toBeGreaterThan(0)

    const setBlobResp = encodeKvSetBlobResponse(1)
    expect(setBlobResp.byteLength).toBeGreaterThan(0)

    const ctxResp = encodeRequestContextResponse(1, 'exec-1', 'sys', [{ name: 't', description: 'd', parameters: {} }])
    expect(ctxResp.byteLength).toBeGreaterThan(0)

    const throwMsg = encodeExecThrowResponse(1, 'err')
    expect(throwMsg.byteLength).toBeGreaterThan(0)

    const closeMsg = encodeExecStreamClose(1)
    expect(closeMsg.byteLength).toBeGreaterThan(0)
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
      auth: {
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
    })
    const models = await adapter.listModels('cursor')
    expect(models.map(model => model.id)).toContain('live-only')
    expect(models.map(model => model.id)).toContain('composer-1.5')
  })

  it('retries model discovery after a successful empty listing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-retry-'))
    const store = new FileOAuthStore(join(dir, OAUTH_CREDENTIALS_FILENAME))
    await store.modify('cursor', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    let attempts = 0
    cursorListingInternals.fetch = async () => {
      attempts += 1
      return attempts === 1
        ? new Uint8Array()
        : encodeMessage(1, concat(encodeString(1, 'live-only'), encodeString(4, 'Live Only')))
    }
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ cursor: {} }),
      resolveApiKey: async () => undefined,
      auth: {
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
    })
    await expect(adapter.listModels('cursor')).rejects.toMatchObject({ code: 'CURSOR_NO_USABLE_MODELS' })
    await expect(adapter.listModels('cursor')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'live-only' }),
    ]))
    expect(attempts).toBe(2)
  })

  it('keeps the fallback when no access token is stored', async () => {
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ cursor: {} }),
      resolveApiKey: async () => undefined,
      auth: memoryAuth(),
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
      auth: {
        credentials: store,
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
    })
    expect((await adapter.listModels('cursor')).map(model => model.id)).not.toContain('live-only')
  })

  it('ignores a non-oauth stored credential when listing Cursor models', async () => {
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ cursor: {} }),
      resolveApiKey: async () => undefined,
      auth: {
        credentials: {
          read: async () => ({ type: 'api_key', key: 'k' }),
          list: async () => [],
          modify: async () => undefined,
          delete: async () => undefined,
        },
        authContext: { env: async () => undefined, fileExists: async () => false },
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
      auth: memoryAuth(),
    })
    expect((await adapter.listModels('cursor')).map(model => model.id)).toEqual(['composer-1.5'])
  })
})
