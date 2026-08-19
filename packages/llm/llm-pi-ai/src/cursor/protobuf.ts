/**
 * Minimal protobuf encoder/decoder for the Cursor AgentService fields this
 * adapter owns. Unknown fields are skipped on read so a Cursor schema addition
 * does not fail listing or streaming.
 *
 * @module dsh-llm-pi-ai/cursor/protobuf
 */

const WIRE_VARINT = 0
const WIRE_LEN = 2

/** One decoded protobuf field. */
export interface ProtoField {
  field: number
  wire: number
  bytes: Uint8Array
  varint?: bigint
}

/**
 * Encode `value` as a protobuf varint.
 * @param value - non-negative integer.
 * @returns the encoded bytes.
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  let n = typeof value === 'bigint' ? value : BigInt(value)
  if (n < 0n) throw new Error('protobuf varint must be non-negative')
  const out: number[] = []
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80)
    n >>= 7n
  }
  out.push(Number(n))
  return Uint8Array.from(out)
}

/**
 * Length-delimited field: tag + length + payload.
 * @param field - field number.
 * @param payload - already-encoded message, string utf8, or bytes.
 * @returns the encoded field.
 */
export function encodeBytes(field: number, payload: Uint8Array): Uint8Array {
  return concat(encodeVarint((field << 3) | WIRE_LEN), encodeVarint(payload.byteLength), payload)
}

/**
 * UTF-8 string field.
 * @param field - field number.
 * @param value - string; empty strings are omitted (proto3 default).
 * @returns the encoded field, or empty when `value` is empty.
 */
export function encodeString(field: number, value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array()
  return encodeBytes(field, new TextEncoder().encode(value))
}

/**
 * Nested message field.
 * @param field - field number.
 * @param payload - encoded submessage.
 * @returns the encoded field, or empty when the submessage is empty.
 */
export function encodeMessage(field: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength === 0) return new Uint8Array()
  return encodeBytes(field, payload)
}

/**
 * Bool / proto3 optional bool. `false` is omitted (proto3 default).
 * @param field - field number.
 * @param value - boolean.
 * @returns the encoded field, or empty when false.
 */
export function encodeBool(field: number, value: boolean): Uint8Array {
  if (!value) return new Uint8Array()
  return concat(encodeVarint((field << 3) | WIRE_VARINT), encodeVarint(1))
}

/**
 * Concatenate protobuf fragments.
 * @param parts - encoded fields.
 * @returns a single buffer.
 */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/**
 * Walk every top-level field in `bytes`. Unknown wire types throw so a
 * length-delimited payload is never mis-sliced into the next field.
 * @param bytes - one protobuf message.
 * @returns fields in encoded order.
 */
export function decodeFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset)
    offset = tag.next
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === WIRE_VARINT) {
      const body = readVarint(bytes, offset)
      offset = body.next
      fields.push({ field, wire, bytes: bytes.subarray(tag.next, body.next), varint: body.value })
      continue
    }
    if (wire === WIRE_LEN) {
      const len = readVarint(bytes, offset)
      const start = len.next
      const end = start + Number(len.value)
      if (end > bytes.byteLength) throw new Error('protobuf length-delimited field overruns the message')
      fields.push({ field, wire, bytes: bytes.subarray(start, end) })
      offset = end
      continue
    }
    // Skip fixed64 (1) and fixed32 (5) so a Cursor schema addition cannot
    // desync the rest of the message.
    if (wire === 1) {
      const end = offset + 8
      if (end > bytes.byteLength) throw new Error('protobuf fixed64 field overruns the message')
      fields.push({ field, wire, bytes: bytes.subarray(offset, end) })
      offset = end
      continue
    }
    if (wire === 5) {
      const end = offset + 4
      if (end > bytes.byteLength) throw new Error('protobuf fixed32 field overruns the message')
      fields.push({ field, wire, bytes: bytes.subarray(offset, end) })
      offset = end
      continue
    }
    throw new Error(`protobuf wire type ${wire} is not supported`)
  }
  return fields
}

/**
 * First string for `field`, or empty when absent.
 * @param fields - decoded fields.
 * @param field - field number.
 * @returns UTF-8 payload.
 */
export function fieldString(fields: readonly ProtoField[], field: number): string {
  const hit = fields.find(entry => entry.field === field && entry.wire === WIRE_LEN)
  return hit === undefined ? '' : new TextDecoder().decode(hit.bytes)
}

/**
 * Every length-delimited payload for `field` (repeated messages or strings).
 * @param fields - decoded fields.
 * @param field - field number.
 * @returns payloads in encoded order.
 */
export function fieldRepeated(fields: readonly ProtoField[], field: number): Uint8Array[] {
  return fields.filter(entry => entry.field === field && entry.wire === WIRE_LEN).map(entry => entry.bytes)
}

/**
 * First varint for `field`.
 * @param fields - decoded fields.
 * @param field - field number.
 * @returns the integer, or `undefined` when absent.
 */
export function fieldVarint(fields: readonly ProtoField[], field: number): bigint | undefined {
  return fields.find(entry => entry.field === field && entry.wire === WIRE_VARINT)?.varint
}

/**
 * Encode a protobuf map of string keys to byte values as repeated entries.
 * @param field - map field number.
 * @param entries - key to payload.
 * @returns concatenated map entries.
 */
export function encodeMapBytes(field: number, entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  return concat(...Object.entries(entries).map(([key, value]) =>
    encodeMessage(field, concat(encodeString(1, key), encodeBytes(2, value))),
  ))
}

/**
 * Decode a protobuf map of string keys to byte values.
 * @param fields - decoded fields of the parent message.
 * @param field - map field number.
 * @returns key to payload; empty keys are skipped.
 */
export function fieldMapBytes(fields: readonly ProtoField[], field: number): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const raw of fieldRepeated(fields, field)) {
    const entry = decodeFields(raw)
    const key = fieldString(entry, 1)
    const value = fieldRepeated(entry, 2)[0]
    if (key.length === 0 || value === undefined) continue
    out.set(key, value)
  }
  return out
}

/**
 * Length-delimited empty submessage (proto3 optional message present with no fields).
 * @param field - field number.
 * @returns tag plus zero length.
 */
export function encodeEmptyMessage(field: number): Uint8Array {
  return encodeBytes(field, new Uint8Array())
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
  let value = 0n
  let shift = 0n
  let offset = start
  while (offset < bytes.byteLength) {
    const byte = bytes[offset]
    /* v8 ignore next -- the loop condition already requires a remaining byte. */
    if (byte === undefined) break
    offset += 1
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: offset }
    shift += 7n
    if (shift > 70n) throw new Error('protobuf varint is too long')
  }
  throw new Error('protobuf varint overruns the message')
}

/**
 * Encode a JSON object as `google.protobuf.Value` (struct). Used for MCP
 * `input_schema` bytes Cursor stores as a Value payload.
 * @param value - JSON-compatible value.
 * @returns encoded Value.
 */
export function encodeProtobufValue(value: unknown): Uint8Array {
  if (value === null) return concat(encodeVarint((1 << 3) | WIRE_VARINT), encodeVarint(0))
  if (typeof value === 'number') {
    const buf = new ArrayBuffer(8)
    new DataView(buf).setFloat64(0, value, true)
    return concat(encodeVarint((2 << 3) | 1), new Uint8Array(buf))
  }
  if (typeof value === 'string') return encodeString(3, value)
  if (typeof value === 'boolean') return concat(encodeVarint((4 << 3) | WIRE_VARINT), encodeVarint(value ? 1 : 0))
  if (Array.isArray(value)) {
    const items = concat(...value.map(item => encodeMessage(1, encodeProtobufValue(item))))
    return encodeMessage(6, items)
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) =>
      concat(encodeString(1, key), encodeMessage(2, encodeProtobufValue(child))),
    )
    const mapEntries = concat(...entries.map(entry => encodeMessage(1, entry)))
    return encodeMessage(5, mapEntries)
  }
  return new Uint8Array()
}
