/** HTTP carrier for the Host route registered by `@deepseek-ai/dsh-experimental-prompt-enhance`. */

/** Document-relative form of the Host's `POST /prompt-enhance` route. */
export const PROMPT_ENHANCE_ROUTE = 'prompt-enhance'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Ask the Host to rewrite one draft.
 * @param sessionId - open Session whose model and conversation the Host uses.
 * @param text - the draft to rewrite.
 * @param signal - aborts the request and the Host's model call.
 * @param fetcher - HTTP carrier.
 * @returns the rewritten prompt; rejects with the Host's message on failure.
 */
export async function requestEnhancement(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const response = await fetcher(PROMPT_ENHANCE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text }),
    signal,
  })
  let payload: { text?: unknown; message?: unknown } = {}
  try {
    payload = await response.json() as typeof payload
  } catch {
    // Swallows a non-JSON body (a fence rejection has none): the status below names the failure.
  }
  if (response.ok && typeof payload.text === 'string') return payload.text
  throw new Error(typeof payload.message === 'string' ? payload.message : `HTTP ${String(response.status)}`)
}
