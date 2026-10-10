/** The HTTP carrier reads JSON refusals and the NDJSON progress stream of an accepted enhancement. */
import { describe, expect, it, vi } from 'vitest'
import { PROMPT_ENHANCE_ROUTE, requestEnhancement, type EnhanceProgress } from '../src/client/request.ts'

/** A response whose body arrives in the given chunks. */
function streamed(chunks: readonly string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), init)
}

const signal = new AbortController().signal

describe('requestEnhancement', () => {
  it('posts the draft and images, reports progress, and returns the rewrite', async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => streamed([
      '{"type":"start","provider":"p","model":"m"}\n{"type":"st',
      'ep","tool":"read","target":"a.ts"}\n\n{"type":"future"}\n',
      '{"type":"done","text":"Rewritten"}\n',
    ]))
    const progress: EnhanceProgress[] = []
    const images = [{ mediaType: 'image/png' as const, data: 'AA==' }]
    await expect(requestEnhancement('s', 'fix', images, signal, (p) => { progress.push(p) }, fetcher)).resolves.toBe('Rewritten')
    expect(fetcher.mock.calls[0]![0]).toBe(PROMPT_ENHANCE_ROUTE)
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ sessionId: 's', text: 'fix', images })
    expect(progress).toEqual([{ type: 'start', model: 'm' }, { type: 'step', tool: 'read', target: 'a.ts' }])
  })

  it('omits an empty image list and ignores malformed progress fields', async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => streamed([
      '{"type":"start"}\n{"type":"step","tool":1}\n{"type":"done","text":"ok"}',
      '\n',
    ]))
    const onProgress = vi.fn()
    await expect(requestEnhancement('s', 'fix', [], signal, onProgress, fetcher)).resolves.toBe('ok')
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ sessionId: 's', text: 'fix' })
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('rejects with the streamed or JSON failure message', async () => {
    const run = (response: Response) => requestEnhancement('s', 'x', [], signal, () => {}, async () => response)
    await expect(run(streamed(['{"type":"error","code":"auth","message":"no key"}\n']))).rejects.toThrow('no key')
    await expect(run(streamed(['{"type":"error"}\n']))).rejects.toThrow('prompt enhancement failed')
    await expect(run(streamed(['{"type":"done"}\n']))).rejects.toThrow('no prompt')
    await expect(run(streamed(['{"type":"start","model":"m"}\n']))).rejects.toThrow('closed the response')
    await expect(run(Response.json({ code: 'busy', message: 'wait' }, { status: 429 }))).rejects.toThrow('wait')
    await expect(run(new Response(null, { status: 401 }))).rejects.toThrow('HTTP 401')
    await expect(run(new Response(null, { status: 200 }))).rejects.toThrow('HTTP 200')
  })

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(streamed(['{"type":"done","text":"ok"}\n']))
    try {
      await expect(requestEnhancement('s', 'x', [], signal, () => {})).resolves.toBe('ok')
      expect(spy).toHaveBeenCalledWith(PROMPT_ENHANCE_ROUTE, expect.objectContaining({ method: 'POST' }))
    } finally {
      spy.mockRestore()
    }
  })
})
