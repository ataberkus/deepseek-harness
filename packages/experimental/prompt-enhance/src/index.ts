/**
 * Host half of prompt enhancement: one `POST /prompt-enhance` route on the
 * composition's `webServer` that rewrites a composer draft with one
 * auxiliary LLM call. The browser composer button
 * (`@deepseek-ai/dsh-experimental-client-ui-prompt-enhance`) posts to it.
 *
 * Every request first passes the composition's `connection` fence (Host/Origin
 * check plus browser login token). The body is bounded JSON naming a live
 * Session and its draft. The call uses the configured route, otherwise the
 * Session's next-request model selection, otherwise the default model. It sees
 * the enhancer system prompt, the Session working directory, the latest
 * conversation text, and the draft; it has no tools. The call is not appended
 * to the Session log: its answer reaches the agent only when the user sends it
 * as an ordinary prompt.
 * @module @deepseek-ai/dsh-experimental-prompt-enhance
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-projection'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { cleanEnhanced, conversationTail, ENHANCE_SYSTEM_PROMPT, enhanceInput } from './enhance.ts'

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

/** Cordis function-plugin name. */
export const name = 'prompt-enhance'
/** Route carrier, trust fence, live Agents, the LLM service, and the default model. */
export const inject = ['webServer', 'connection', 'agents', 'llm', 'agentDefaultModel']

/** Prompt-enhancement deployment policy. */
export interface Config {
  /** Longest accepted draft, in characters. */
  readonly maxDraftChars: number
  /** Latest user and assistant messages shown to the enhancer. */
  readonly historyMessages: number
  /** Character cap of each shown conversation message. */
  readonly historyMessageChars: number
  /** Output-token cap of the enhancement call. */
  readonly maxOutputTokens: number
  /** End-to-end call deadline in milliseconds. */
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

export const Config: z<Config> = z.object({
  maxDraftChars: positive(),
  historyMessages: z.number().step(1).min(0).required(),
  historyMessageChars: positive(),
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

/** Wire failure answered with a JSON `{ code, message }` body. */
class RouteFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

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

/** Validate one request body at the wire. */
function parseBody(text: string, maxDraftChars: number): { sessionId: string; text: string } {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is answered as a bad request below.
    body = undefined
  }
  const { sessionId, text: draft } = (typeof body === 'object' && body !== null ? body : {}) as { sessionId?: unknown; text?: unknown }
  if (typeof sessionId !== 'string' || sessionId === '' || typeof draft !== 'string') {
    throw new RouteFailure(400, 'bad-request', 'request body must be JSON with string "sessionId" and "text"')
  }
  if (draft.trim() === '') throw new RouteFailure(400, 'bad-request', 'the draft is empty')
  if (draft.length > maxDraftChars) {
    throw new RouteFailure(413, 'draft-too-long', `the draft exceeds ${String(maxDraftChars)} characters`)
  }
  return { sessionId, text: draft }
}

/** Translate a terminal finish reason into a call failure. */
function finishError(finish: FinishReason): RouteFailure | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted':
      return new RouteFailure(502, finish.failure.code, finish.failure.message)
    case 'max-tokens':
      return new RouteFailure(502, 'max-tokens', 'the rewritten prompt reached maxOutputTokens')
    case 'tool-calls':
      return new RouteFailure(502, 'tool-calls', 'the model requested a tool instead of answering')
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

  const enhance = async (agent: Agent, draft: string, signal: AbortSignal): Promise<{ text: string; route: EnhanceRoute }> => {
    const route = routeFor(agent)
    const tail = conversationTail(agent.session.deriveMessages(), config.historyMessages, config.historyMessageChars)
    using callDeadline = deadline(signal, config.timeoutMs, PROMPT_ENHANCE_TIMEOUT_CODE)
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
      system: ENHANCE_SYSTEM_PROMPT,
      messages: [createUserMessage({
        content: [{ type: 'text', text: enhanceInput(draft, tail, agent.session.header.cwd) }],
        source: { kind: 'dsh-prompt-enhance' },
      })],
      maxTokens: config.maxOutputTokens,
      signal: callDeadline.signal,
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    } catch (error) {
      if (callDeadline.signal.aborted && !signal.aborted) throw new RouteFailure(504, 'timeout', 'prompt enhancement timed out')
      throw error
    }
    if (callDeadline.signal.aborted && !signal.aborted) throw new RouteFailure(504, 'timeout', 'prompt enhancement timed out')
    const failure = finishError(assembler.finish)
    if (failure !== undefined) throw failure
    const text = cleanEnhanced(assembler.blocks()
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join(''))
    if (text === '') throw new RouteFailure(502, 'empty', 'the model returned no prompt')
    return { text, route }
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
      try {
        const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          throw new RouteFailure(415, 'unsupported-media-type', 'content-type must be application/json')
        }
        // UTF-8 needs at most 4 bytes per character; 1 KiB covers the JSON framing.
        const text = await readBoundedBody(req, config.maxDraftChars * 4 + 1024)
        if (text === null) throw new RouteFailure(413, 'draft-too-long', 'request body is too large')
        const body = parseBody(text, config.maxDraftChars)
        const agent = ctx.agents.get(SessionId(body.sessionId))
        if (agent === undefined) throw new RouteFailure(404, 'session-not-found', `session "${body.sessionId}" is not open`)
        if (running >= config.maxConcurrent) {
          throw new RouteFailure(429, 'busy', 'wait for the running prompt enhancement to finish')
        }
        running++
        admitted = true
        const result = await enhance(agent, body.text, controller.signal)
        sendJson(res, 200, { text: result.text, provider: result.route.provider, model: result.route.model })
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof RouteFailure) {
          sendJson(res, error.status, { code: error.code, message: error.message })
          return
        }
        ctx.logger.warn(`prompt-enhance: enhancement failed: ${String(error)}`)
        sendJson(res, 502, { code: 'llm-failed', message: error instanceof Error ? error.message : String(error) })
      } finally {
        if (admitted) running--
      }
    },
  }), `prompt-enhance: POST ${PROMPT_ENHANCE_PATH}`)
}
