/** Cursor Run stream branches: malformed KV and exec frames from the server. */
import { afterEach, describe, expect, it } from 'vitest'
import { cursorConnectInternals, frameConnectMessage } from '../src/cursor/connect.ts'
import { cursorModel } from '../src/cursor/models.ts'
import {
  concat,
  decodeFields,
  encodeBytes,
  encodeEmptyMessage,
  encodeMessage,
  encodeString,
  encodeVarint,
  fieldRepeated,
  fieldString,
  fieldVarint,
} from '../src/cursor/protobuf.ts'
import { createBlobId } from '../src/cursor/request.ts'
import { resetCursorSessions, streamCursor } from '../src/cursor/stream.ts'

const originalRequest = cursorConnectInternals.request

afterEach(() => {
  cursorConnectInternals.request = originalRequest
  resetCursorSessions()
})

const MODEL = cursorModel('composer-1.5', 'Composer 1.5', true)
const varintField = (field: number, value: number | bigint): Uint8Array => concat(encodeVarint((field << 3) | 0), encodeVarint(value))
const turnEnd = (): Uint8Array => frameConnectMessage(encodeMessage(1, encodeEmptyMessage(14)))

async function run(frames: readonly Uint8Array[], sessionId: string): Promise<Uint8Array[]> {
  const sent: Uint8Array[] = []
  cursorConnectInternals.request = async function* (request) {
    request.onOpen?.((payload) => { sent.push(payload) })
    for (const frame of frames) yield frame
    yield turnEnd()
  }
  const stream = streamCursor(MODEL, {
    messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
  }, { headers: { authorization: 'Bearer tok' }, sessionId })
  for await (const event of stream) void event
  return sent
}

describe('cursor KV server messages', () => {
  it('answers only KV messages with a usable id and tolerates incomplete blob arguments', async () => {
    const stored = new TextEncoder().encode('payload')
    const sent = await run([
      // No id: ignored.
      frameConnectMessage(encodeMessage(4, encodeMessage(2, encodeBytes(1, createBlobId(stored))))),
      // Id beyond the safe integer range: ignored.
      frameConnectMessage(encodeMessage(4, concat(
        varintField(1, BigInt(Number.MAX_SAFE_INTEGER) + 1n),
        encodeMessage(2, encodeBytes(1, createBlobId(stored))),
      ))),
      // getBlobArgs without a blob id: answered with an empty result.
      frameConnectMessage(encodeMessage(4, concat(varintField(1, 5), encodeMessage(2, encodeEmptyMessage(2))))),
      // setBlobArgs without blob data: acknowledged without storing.
      frameConnectMessage(encodeMessage(4, concat(varintField(1, 6), encodeMessage(3, encodeBytes(1, createBlobId(stored)))))),
    ], 'kv-incomplete')
    expect(sent).toHaveLength(2)
    const getReply = fieldRepeated(decodeFields(sent[0] ?? new Uint8Array()), 3)[0] ?? new Uint8Array()
    expect(fieldVarint(decodeFields(getReply), 1)).toBe(5n)
    const setReply = fieldRepeated(decodeFields(sent[1] ?? new Uint8Array()), 3)[0] ?? new Uint8Array()
    expect(fieldVarint(decodeFields(setReply), 1)).toBe(6n)
    expect(fieldRepeated(decodeFields(setReply), 3)).toHaveLength(1)
  })
})

describe('cursor exec server messages', () => {
  it('ignores exec frames without a usable id', async () => {
    const sent = await run([
      frameConnectMessage(encodeMessage(2, encodeEmptyMessage(10))),
      frameConnectMessage(encodeMessage(2, concat(varintField(1, BigInt(Number.MAX_SAFE_INTEGER) + 1n), encodeEmptyMessage(10)))),
    ], 'exec-no-id')
    expect(sent).toEqual([])
  })

  it('approves an MCP probe that carries no exec id without echoing one', async () => {
    const sent = await run([
      frameConnectMessage(encodeMessage(2, concat(varintField(1, 9), encodeMessage(11, varintField(7, 1))))),
      frameConnectMessage(encodeMessage(2, concat(varintField(1, 10), encodeString(15, 'exec-x'), encodeMessage(11, varintField(7, 1))))),
    ], 'exec-approve')
    expect(sent).toHaveLength(2)
    const approvalOf = (payload: Uint8Array | undefined): { id: bigint | undefined; execId: string } => {
      const exec = fieldRepeated(decodeFields(payload ?? new Uint8Array()), 2)[0] ?? new Uint8Array()
      const mcp = fieldRepeated(decodeFields(exec), 11)[0] ?? new Uint8Array()
      const fields = decodeFields(mcp)
      return { id: fieldVarint(fields, 1), execId: fieldString(fields, 15) }
    }
    expect(approvalOf(sent[0])).toEqual({ id: 9n, execId: '' })
    expect(approvalOf(sent[1])).toEqual({ id: 10n, execId: 'exec-x' })
  })
})
