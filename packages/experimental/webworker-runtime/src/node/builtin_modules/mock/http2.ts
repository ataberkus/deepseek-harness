/**
 * `node:http2` stub. A browser worker has no HTTP/2 client session; the pi-ai
 * Cursor transport mounts and reports the gap when it dials.
 */
import { notImplementedFail } from '../../notImplementedFail.ts'

const MODULE = 'node:http2'

/** Client session dial (unavailable). */
export const connect: typeof import('node:http2').connect = notImplementedFail(MODULE, 'connect')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** The `node:http2` declarations this module stands in for. */
type NodeFace = Partial<typeof import('node:http2')>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { connect } satisfies NodeFace
