/**
 * Connect/protobuf requests over HTTP/2 for Cursor AgentService RPCs.
 *
 * @module dsh-llm-pi-ai/cursor/connect
 */

import { randomUUID } from 'node:crypto'
import http2 from 'node:http2'
import {
  CURSOR_CLIENT_TYPE,
  CURSOR_CLIENT_VERSION,
} from './constants.ts'

const CONNECT_FLAG_END_STREAM = 0x02
const MAX_UNARY_BYTES = 4 * 1024 * 1024
const MAX_STREAM_BYTES = 32 * 1024 * 1024

/** One parsed Connect data frame (not the end-stream trailer). */
export interface ConnectDataFrame {
  /** Protobuf payload. */
  payload: Uint8Array
}

/** Injectable HTTP/2 so tests never open a real Cursor connection. */
export const cursorConnectInternals = {
  /**
   * POST `path` on `baseUrl` with a raw protobuf or Connect+proto body and
   * yield response bytes. Tests replace this with a fixture iterator.
   */
  request: defaultHttp2Request,
  /* v8 ignore next -- tests replace `connect` so this never dials Cursor. */
  connect: (origin: string): http2.ClientHttp2Session => http2.connect(origin),
}

/** Options for one Cursor AgentService RPC. */
export interface ConnectRequest {
  /** AgentService origin, no trailing slash. */
  baseUrl: string
  /** RPC path, e.g. `/agent.v1.AgentService/Run`. */
  path: string
  /** Bearer access token; never logged. */
  accessToken: string
  /** Encoded protobuf request; unary calls send it raw, streams frame it. */
  body: Uint8Array
  /** Send a unary protobuf request instead of a Connect-framed stream request. */
  unary?: boolean
  /** Abort the request. */
  signal?: AbortSignal
  /** Called once a streaming request can accept additional client frames. */
  onOpen?: (send: (payload: Uint8Array) => void) => void
}

/**
 * Frame a protobuf payload as a Connect data frame (flags 0).
 * @param payload - protobuf bytes.
 * @returns 5-byte header plus payload.
 */
export function frameConnectMessage(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength)
  out[0] = 0
  new DataView(out.buffer).setUint32(1, payload.byteLength, false)
  out.set(payload, 5)
  return out
}

/**
 * Split a Connect byte stream into protobuf payloads, ignoring end-stream
 * trailer frames (flag bit 0x02).
 * @param chunks - raw HTTP/2 DATA bytes.
 * @returns protobuf payloads in order.
 */
export function decodeConnectFrames(chunks: Uint8Array): ConnectDataFrame[] {
  const frames: ConnectDataFrame[] = []
  let offset = 0
  while (offset + 5 <= chunks.byteLength) {
    const flags = chunks[offset]
    /* v8 ignore next -- Uint8Array index is defined while offset is in range. */
    if (flags === undefined) break
    const length = new DataView(
      chunks.buffer,
      chunks.byteOffset + offset,
      chunks.byteLength - offset,
    ).getUint32(1, false)
    const end = offset + 5 + length
    if (end > chunks.byteLength) break
    if ((flags & CONNECT_FLAG_END_STREAM) === 0) {
      frames.push({ payload: chunks.subarray(offset + 5, end) })
    }
    offset = end
  }
  return frames
}

/**
 * Unary Cursor RPC: one raw protobuf request and one protobuf reply, with a
 * Connect-framed reply also accepted for older endpoints.
 * @param request - origin, path, token, and protobuf body.
 * @returns decoded protobuf payload.
 */
export async function connectUnary(request: ConnectRequest): Promise<Uint8Array> {
  const bytes = await readAll(
    cursorConnectInternals.request({ ...request, unary: true }),
    MAX_UNARY_BYTES,
  )
  const framed = decodeConnectFrames(bytes)
  if (framed[0] !== undefined) return framed[0].payload
  return bytes
}

/**
 * Bidirectional Connect RPC: one request frame, optional client frames, then
 * protobuf response frames. The request stays open until the server finishes.
 * @param request - origin, path, token, protobuf body.
 * @yields protobuf payloads, excluding end-stream trailers.
 * @returns an async iterable of protobuf payloads.
 */
export async function* connectStream(request: ConnectRequest): AsyncIterable<Uint8Array> {
  let pending = new Uint8Array()
  for await (const chunk of cursorConnectInternals.request(request)) {
    if (pending.byteLength + chunk.byteLength > MAX_STREAM_BYTES) {
      throw new Error('Cursor AgentService stream exceeded the response size limit')
    }
    const next = new Uint8Array(pending.byteLength + chunk.byteLength)
    next.set(pending)
    next.set(chunk, pending.byteLength)
    pending = next
    let offset = 0
    while (offset + 5 <= pending.byteLength) {
      const flags = pending[offset]
      /* v8 ignore next -- Uint8Array index is defined while offset is in range. */
      if (flags === undefined) break
      const length = new DataView(
        pending.buffer,
        pending.byteOffset + offset,
        pending.byteLength - offset,
      ).getUint32(1, false)
      const end = offset + 5 + length
      if (end > pending.byteLength) break
      if ((flags & CONNECT_FLAG_END_STREAM) === 0) yield pending.subarray(offset + 5, end)
      offset = end
    }
    if (offset > 0) pending = pending.subarray(offset)
  }
}

async function* defaultHttp2Request(request: ConnectRequest): AsyncIterable<Uint8Array> {
  const origin = request.baseUrl.replace(/\/+$/, '')
  const session = cursorConnectInternals.connect(origin)
  const close = (): void => {
    try {
      session.close()
    } catch {
      // The session may already be closed after a stream error or abort.
    }
  }
  const onAbort = (): void => {
    close()
  }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const stream = session.request({
      ':method': 'POST',
      ':path': request.path,
      ':scheme': 'https',
      ':authority': new URL(origin).host,
      'content-type': request.unary === true ? 'application/proto' : 'application/connect+proto',
      'connect-protocol-version': '1',
      te: 'trailers',
      authorization: `Bearer ${request.accessToken}`,
      'x-cursor-client-type': CURSOR_CLIENT_TYPE,
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
      'x-ghost-mode': 'true',
      'x-request-id': randomUUID(),
    })
    const queue: Uint8Array[] = []
    let pending: ((result: IteratorResult<Uint8Array>) => void) | undefined
    const state = { done: false, failure: undefined as Error | undefined }
    const emit = (chunk?: Uint8Array): void => {
      if (pending !== undefined) {
        const settle = pending
        pending = undefined
        if (chunk !== undefined) settle({ value: chunk, done: false })
        else settle({ value: undefined, done: true })
        return
      }
      if (chunk !== undefined) queue.push(chunk)
    }
    const fail = (error: Error): void => {
      state.failure ??= error
      state.done = true
      emit()
    }
    stream.on('response', (headers: http2.IncomingHttpHeaders) => {
      const status = Number(headers[':status'] ?? 0)
      if (status > 0 && (status < 200 || status >= 300)) {
        fail(new Error(`Cursor AgentService request returned HTTP ${status}`))
      }
    })
    stream.on('trailers', (headers: http2.IncomingHttpHeaders) => {
      const status = headers['grpc-status']
      if (typeof status === 'string' && status !== '0') {
        fail(new Error(`Cursor AgentService request returned gRPC status ${status}`))
      }
    })
    stream.on('data', (chunk: Buffer) => {
      if (state.failure === undefined) emit(new Uint8Array(chunk))
    })
    stream.on('error', (error: Error) => { fail(error) })
    stream.on('end', () => {
      state.done = true
      emit()
    })
    request.signal?.addEventListener('abort', () => {
      fail(new Error('Cursor AgentService request aborted'))
      stream.close()
    }, { once: true })
    const send = (payload: Uint8Array): void => {
      if (request.unary === true || state.done || state.failure !== undefined) return
      try {
        stream.write(frameConnectMessage(payload))
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (request.unary === true) stream.end(request.body)
    else {
      stream.write(frameConnectMessage(request.body))
      request.onOpen?.(send)
    }
    while (true) {
      if (queue.length > 0) {
        const next = queue.shift()
        /* v8 ignore next -- length > 0 means shift returns the queued chunk. */
        if (next !== undefined) yield next
        continue
      }
      if (state.done) {
        if (state.failure !== undefined) throw state.failure
        return
      }
      const chunk = await new Promise<Uint8Array | undefined>((resolve) => {
        pending = (result) => {
          resolve(result.done === true ? undefined : result.value)
        }
      })
      if (chunk !== undefined) yield chunk
    }
  } finally {
    request.signal?.removeEventListener('abort', onAbort)
    close()
  }
}

async function readAll(chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of chunks) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error('Cursor AgentService reply exceeded the response size limit')
    parts.push(chunk)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
