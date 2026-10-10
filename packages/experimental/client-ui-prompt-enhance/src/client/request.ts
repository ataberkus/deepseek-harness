/** HTTP carrier for the Host route registered by `@deepseek-ai/dsh-experimental-prompt-enhance`. */

import type { SubmitAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Document-relative form of the Host's `POST /prompt-enhance` route. */
export const PROMPT_ENHANCE_ROUTE = 'prompt-enhance'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** One draft image sent as enhancer context. */
export type EnhanceImage = Omit<Extract<SubmitAttachment, { type: 'image' }>, 'type'>

/** Live facts of a running enhancement, reported in arrival order. */
export type EnhanceProgress =
  | { readonly type: 'start'; readonly model: string }
  | { readonly type: 'step'; readonly tool: string; readonly target: string }

type Frame =
  | { type: 'start'; model?: unknown }
  | { type: 'step'; tool?: unknown; target?: unknown }
  | { type: 'done'; text?: unknown }
  | { type: 'error'; message?: unknown }

/** Read a JSON error body; a fence rejection has none. */
async function failureOf(response: Response): Promise<Error> {
  let payload: { message?: unknown } = {}
  try {
    payload = await response.json() as typeof payload
  } catch {
    // Swallows a non-JSON body: the status names the failure.
  }
  return new Error(typeof payload.message === 'string' ? payload.message : `HTTP ${String(response.status)}`)
}

/** Apply one NDJSON frame; returns the rewritten prompt on `done`. */
function applyFrame(line: string, onProgress: (progress: EnhanceProgress) => void): string | undefined {
  const frame = JSON.parse(line) as Frame
  switch (frame.type) {
    case 'start':
      if (typeof frame.model === 'string') onProgress({ type: 'start', model: frame.model })
      return undefined
    case 'step':
      if (typeof frame.tool === 'string' && typeof frame.target === 'string') onProgress({ type: 'step', tool: frame.tool, target: frame.target })
      return undefined
    case 'done':
      if (typeof frame.text === 'string') return frame.text
      throw new Error('the Host returned no prompt')
    case 'error':
      throw new Error(typeof frame.message === 'string' ? frame.message : 'prompt enhancement failed')
    default:
      // Unknown frame types from a newer Host carry nothing this control shows.
      return undefined
  }
}

/**
 * Ask the Host to rewrite one draft.
 * @param sessionId - open Session whose model, workspace, and conversation the Host uses.
 * @param text - the draft to rewrite.
 * @param images - draft images shown to the enhancer.
 * @param signal - aborts the request and the Host's model call.
 * @param onProgress - receives the model in use and each workspace lookup.
 * @param fetcher - HTTP carrier.
 * @returns the rewritten prompt; rejects with the Host's message on failure.
 */
export async function requestEnhancement(
  sessionId: string,
  text: string,
  images: readonly EnhanceImage[],
  signal: AbortSignal,
  onProgress: (progress: EnhanceProgress) => void,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const response = await fetcher(PROMPT_ENHANCE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text, ...images.length === 0 ? {} : { images } }),
    signal,
  })
  if (!response.ok || response.body === null) throw await failureOf(response)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value !== undefined) buffered += value
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      const result = line === '' ? undefined : applyFrame(line, onProgress)
      if (result !== undefined) {
        void reader.cancel()
        return result
      }
      newline = buffered.indexOf('\n')
    }
    if (done) break
  }
  throw new Error('the Host closed the response before answering')
}
