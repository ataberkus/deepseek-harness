/**
 * Host half of prompt enhancement: one `POST /prompt-enhance` route on the
 * composition's `webServer` that rewrites a composer draft. The browser
 * composer button (`@deepseek-ai/dsh-experimental-client-ui-prompt-enhance`)
 * posts to it.
 *
 * Every request first passes the composition's `connection` fence (Host/Origin
 * check plus browser login token). The body is bounded JSON naming a live
 * Session, its draft, and optional draft images. The call uses the configured
 * route, otherwise the Session's next-request model selection, otherwise the
 * default model. It sees the enhancer system prompt, the Session working
 * directory, the workspace instructions the Session has loaded, the latest
 * conversation text, the draft, and its images. Before answering, the model may
 * run up to `maxToolCalls` read-only `read`/`grep`/`glob` lookups confined to
 * the working directory ({@link module:@deepseek-ai/dsh-experimental-prompt-enhance/lookup}).
 *
 * An accepted request is answered `200` with an NDJSON stream of
 * {@link EnhanceFrame}s: `start`, one `step` per lookup, then `done` or
 * `error`. Requests refused before the call starts are answered with a JSON
 * `{ code, message }` error status. Neither the call nor its lookups are
 * appended to the Session log: the answer reaches the agent only when the user
 * sends it as an ordinary prompt. Draft images are stored through
 * `ctx.attachments` so the model can see them.
 * @module @deepseek-ai/dsh-experimental-prompt-enhance
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-instructions'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { ImageMediaType, PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subprocess'
import { BlockAssembler, createToolResultMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, FinishReason, GenerateOptions, RequestMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { cleanEnhanced, conversationTail, enhanceInput, enhanceSystemPrompt, workspaceInstructions } from './enhance.ts'
import { LOOKUP_TOOLS, prepareLookup, settleLookup, type LookupError, type LookupStep } from './lookup.ts'

export type { LookupStep, LookupTool } from './lookup.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * The enhancement request's own draft message. The call is never appended
     * to a Session log, so readers neither see nor depend on this kind.
     * @persistenceAttribution
     */
    'dsh-prompt-enhance': { kind: 'dsh-prompt-enhance' } & ContextFormed
  }
}

/** Absolute route path; the browser addresses it document-relative as `prompt-enhance`. */
export const PROMPT_ENHANCE_PATH = '/prompt-enhance'

/** Timeout reason code of one enhancement call. */
export const PROMPT_ENHANCE_TIMEOUT_CODE = 'PROMPT_ENHANCE_TIMEOUT'

/** One NDJSON line of an accepted enhancement's response stream. */
export type EnhanceFrame =
  | { readonly type: 'start'; readonly provider: string; readonly model: string }
  | ({ readonly type: 'step' } & LookupStep)
  | { readonly type: 'done'; readonly text: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string }

/** Cordis function-plugin name. */
export const name = 'prompt-enhance'
/** Route carrier, trust fence, live Agents, the LLM service, the default model, and lookup spawns. */
export const inject = ['webServer', 'connection', 'agents', 'llm', 'agentDefaultModel', 'subprocess']

/** Prompt-enhancement deployment policy. */
export interface Config {
  /** Longest accepted draft, in characters. */
  readonly maxDraftChars: number
  /** Latest user prompts and assistant messages shown to the enhancer. */
  readonly historyMessages: number
  /** Character cap of each shown conversation message. */
  readonly historyMessageChars: number
  /** Character cap of the loaded workspace instructions shown to the enhancer; 0 omits them. */
  readonly instructionsMaxChars: number
  /** Workspace lookups one enhancement may run; 0 sends no tools. */
  readonly maxToolCalls: number
  /** Longest lookup result returned to the model, in characters. */
  readonly toolResultMaxChars: number
  /** Largest file a lookup reads, and largest raw search output it parses, in bytes. */
  readonly scanMaxBytes: number
  /** Output-token cap of each model request. */
  readonly maxOutputTokens: number
  /** End-to-end deadline of one enhancement, including lookups, in milliseconds. */
  readonly timeoutMs: number
  /** Enhancement calls allowed at once across all Sessions. */
  readonly maxConcurrent: number
  /** Explicit provider route; must be paired with `model`. Omitted, the Session's model is used. */
  readonly provider?: string
  /** Explicit model id; must be paired with `provider`. */
  readonly model?: string
  /** Adapter-owned reasoning effort; omitted, the selected model's effort is used. */
  readonly reasoningEffort?: string
}

const positive = (): z<number> => z.number().step(1).min(1).required()
const natural = (): z<number> => z.number().step(1).min(0).required()

export const Config: z<Config> = z.object({
  maxDraftChars: positive(),
  historyMessages: natural(),
  historyMessageChars: positive(),
  instructionsMaxChars: natural(),
  maxToolCalls: natural(),
  toolResultMaxChars: positive(),
  scanMaxBytes: positive(),
  maxOutputTokens: positive(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  maxConcurrent: positive(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface PromptEnhanceConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Model route of one call. */
interface EnhanceRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

type DraftImage = Extract<PromptContentPart, { type: 'image' }>

/** One validated request body. */
interface EnhanceRequest {
  readonly sessionId: string
  readonly text: string
  readonly images: readonly DraftImage[]
}

/** Wire failure answered with a JSON `{ code, message }` body, or an `error` frame once streaming. */
class RouteFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded UTF-8 body; null past the ceiling (remainder drained). */
async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  // http server streams without setEncoding always yield Buffer chunks.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > maxBytes) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Validate one image entry of the request body. */
function parseImage(value: unknown): DraftImage {
  const { mediaType, data, name: label } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  if (typeof mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(mediaType) || typeof data !== 'string'
    || (label !== undefined && typeof label !== 'string')) {
    throw new RouteFailure(400, 'bad-request', '"images" entries must carry a supported "mediaType" and base64 "data"')
  }
  return { type: 'image', mediaType: mediaType as ImageMediaType, data, ...label === undefined ? {} : { name: label } }
}

/** Validate one request body at the wire. */
function parseBody(text: string, maxDraftChars: number): EnhanceRequest {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is answered as a bad request below.
    body = undefined
  }
  const { sessionId, text: draft, images } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId === '' || typeof draft !== 'string') {
    throw new RouteFailure(400, 'bad-request', 'request body must be JSON with string "sessionId" and "text"')
  }
  if (images !== undefined && !Array.isArray(images)) throw new RouteFailure(400, 'bad-request', '"images" must be an array')
  if (draft.trim() === '') throw new RouteFailure(400, 'bad-request', 'the draft is empty')
  if (draft.length > maxDraftChars) {
    throw new RouteFailure(413, 'draft-too-long', `the draft exceeds ${String(maxDraftChars)} characters`)
  }
  return { sessionId, text: draft, images: (images ?? []).map(parseImage) }
}

/** Translate a non-tool terminal finish reason into a call failure. */
function finishError(finish: FinishReason): RouteFailure | undefined {
  switch (finish.kind) {
    case 'stop':
    case 'tool-calls':
      return undefined
    case 'error':
    case 'aborted':
      return new RouteFailure(502, finish.failure.code, finish.failure.message)
    case 'max-tokens':
      return new RouteFailure(502, 'max-tokens', 'the model reply reached maxOutputTokens')
    default:
      return new RouteFailure(502, 'unknown-finish', `unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Register the enhancement route behind the connection trust fence.
 * @param ctx - Host Context with the injected services.
 * @param config - validated deployment policy.
 */
export function apply(ctx: Context, config: Config): void {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('prompt-enhance: provider and model must be configured together')
  }
  const connection = Reflect.get(ctx, 'connection') as PromptEnhanceConnection
  let running = 0

  const routeFor = (agent: Agent): EnhanceRoute => {
    const effort = (selected: string | undefined): { reasoningEffort?: string } => {
      const value = config.reasoningEffort ?? selected
      return value === undefined ? {} : { reasoningEffort: value }
    }
    if (config.provider !== undefined && config.model !== undefined) {
      return { provider: config.provider, model: config.model, ...effort(undefined) }
    }
    const state = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')
    const selected = state?.pending ?? state?.lastUsed
    if (selected != null) return { provider: selected.provider, model: selected.model, ...effort(selected.reasoningEffort) }
    const fallback = ctx.agentDefaultModel.currentSelection()
    return {
      provider: fallback.provider,
      model: fallback.model,
      ...effort(fallback.reasoningEffort === undefined ? undefined : String(fallback.reasoningEffort)),
    }
  }

  /** Store draft images so the request can reference them; text-only drafts touch no storage. */
  const admitImages = async (images: readonly DraftImage[]): Promise<ContentBlock[]> => {
    if (images.length === 0) return []
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new RouteFailure(400, 'images-unsupported', 'this composition stores no images')
    try {
      const admitted = await attachments.admitPromptContent(images)
      return admitted.flatMap((part): ContentBlock[] => part.type === 'image' ? [{ type: 'image', attachment: part.attachment }] : [])
    } catch (error: unknown) {
      if (attachments.isAttachmentError(error)) throw new RouteFailure(400, error.code, error.message)
      throw error
    }
  }

  const lookupLimits = { scanMaxBytes: config.scanMaxBytes, resultMaxChars: config.toolResultMaxChars }

  const enhance = async (
    agent: Agent,
    draft: string,
    images: readonly ContentBlock[],
    route: EnhanceRoute,
    signal: AbortSignal,
    emit: (frame: EnhanceFrame) => void,
  ): Promise<string> => {
    const history = agent.session.deriveMessages()
    const input = enhanceInput(draft, {
      cwd: agent.session.header.cwd,
      instructions: workspaceInstructions(history, config.instructionsMaxChars),
      tail: conversationTail(history, config.historyMessages, config.historyMessageChars),
    })
    using callDeadline = deadline(signal, config.timeoutMs, PROMPT_ENHANCE_TIMEOUT_CODE)
    const timedOut = (): boolean => callDeadline.signal.aborted && !signal.aborted
    const messages: RequestMessage[] = [createUserMessage({
      content: [{ type: 'text', text: input }, ...images],
      source: { kind: 'dsh-prompt-enhance' },
    })]
    const system = enhanceSystemPrompt(config.maxToolCalls, images.length > 0)
    let lookups = 0
    // Each round either answers or runs at least one lookup; past the budget every
    // lookup is refused, so one extra round is the model's last chance to answer.
    for (let round = 0; round <= config.maxToolCalls + 1; round++) {
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
        system,
        messages,
        ...(config.maxToolCalls > 0 ? { tools: [...LOOKUP_TOOLS] } : {}),
        maxTokens: config.maxOutputTokens,
        signal: callDeadline.signal,
      }
      const assembler = new BlockAssembler()
      try {
        for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
      } catch (error) {
        if (timedOut()) throw new RouteFailure(504, 'timeout', 'prompt enhancement timed out')
        throw error
      }
      if (timedOut()) throw new RouteFailure(504, 'timeout', 'prompt enhancement timed out')
      const failure = finishError(assembler.finish)
      if (failure !== undefined) throw failure
      const blocks = assembler.blocks()
      const calls = blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
      if (calls.length === 0) {
        const text = cleanEnhanced(blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
        if (text === '') throw new RouteFailure(502, 'empty', 'the model returned no prompt')
        return text
      }
      const replayState = assembler.replayState
      messages.push(assembler.message({
        provider: route.provider, model: route.model, ...replayState === undefined ? {} : { replayState },
      }))
      for (const call of calls) {
        let result: { text: string; isError: boolean }
        if (lookups >= config.maxToolCalls) {
          result = { text: 'Lookup limit reached. Answer now with the rewritten prompt.', isError: true }
        } else {
          lookups++
          try {
            const lookup = prepareLookup(ctx, agent, call.name, call.arguments, lookupLimits, callDeadline.signal)
            emit({ type: 'step', ...lookup.step })
            result = await settleLookup(lookup)
          } catch (error: unknown) {
            // prepareLookup throws only LookupError, whose message is the model-facing refusal.
            result = { text: (error as LookupError).message, isError: true }
          }
        }
        if (timedOut()) throw new RouteFailure(504, 'timeout', 'prompt enhancement timed out')
        messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: result.text }], isError: result.isError }))
      }
    }
    throw new RouteFailure(502, 'tool-calls', 'the model kept looking up instead of answering')
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PROMPT_ENHANCE_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const controller = new AbortController()
      res.on('close', () => { if (!res.writableEnded) controller.abort() })
      let admitted = false
      let streaming = false
      const emit = (frame: EnhanceFrame): void => { res.write(`${JSON.stringify(frame)}\n`) }
      try {
        const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          throw new RouteFailure(415, 'unsupported-media-type', 'content-type must be application/json')
        }
        // UTF-8 needs at most 4 bytes per character; base64 adds a third to the
        // image bytes; 1 KiB per image plus 1 KiB covers the JSON framing.
        const limits = ctx.get('attachments')?.imageLimits
        const imageBudget = limits === undefined ? 0 : Math.ceil(limits.maxMessageImageBytes / 3) * 4 + limits.maxImagesPerMessage * 1024
        const text = await readBoundedBody(req, config.maxDraftChars * 4 + imageBudget + 1024)
        if (text === null) throw new RouteFailure(413, 'draft-too-long', 'request body is too large')
        const body = parseBody(text, config.maxDraftChars)
        const agent = ctx.agents.get(SessionId(body.sessionId))
        if (agent === undefined) throw new RouteFailure(404, 'session-not-found', `session "${body.sessionId}" is not open`)
        if (running >= config.maxConcurrent) {
          throw new RouteFailure(429, 'busy', 'wait for the running prompt enhancement to finish')
        }
        running++
        admitted = true
        const images = await admitImages(body.images)
        const route = routeFor(agent)
        res.statusCode = 200
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        streaming = true
        emit({ type: 'start', provider: route.provider, model: route.model })
        const result = await enhance(agent, body.text, images, route, controller.signal, emit)
        emit({ type: 'done', text: result })
        res.end()
      } catch (error) {
        if (controller.signal.aborted) return
        const failure = error instanceof RouteFailure
          ? error
          : new RouteFailure(502, 'llm-failed', error instanceof Error ? error.message : String(error))
        if (!(error instanceof RouteFailure)) ctx.logger.warn(`prompt-enhance: enhancement failed: ${String(error)}`)
        if (streaming) {
          emit({ type: 'error', code: failure.code, message: failure.message })
          res.end()
          return
        }
        sendJson(res, failure.status, { code: failure.code, message: failure.message })
      } finally {
        if (admitted) running--
      }
    },
  }), `prompt-enhance: POST ${PROMPT_ENHANCE_PATH}`)
}
