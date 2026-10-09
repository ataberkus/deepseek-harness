import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { fileHandleText } from '@deepseek-ai/dsh-llm'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return ctx
}

describe('file request text', () => {
  it('renders the no-path handle when no attachment provider is mounted', async () => {
    const ctx = await setup()
    const ref: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
      name: 'report.csv',
      bytes: 7,
    }
    expect(ctx.llm.fileRequestText(ref)).toBe(fileHandleText(ref, undefined))
    expect(ctx.llm.fileRequestText(ref)).toContain('"report.csv"')
  })
})

describe('remote API-key login failures', () => {
  it('reports a non-Error rejection by its string form', async () => {
    const ctx = await setup()
    const login = vi.fn().mockRejectedValue('plain refusal')
    ctx.llm.registerApiKeyLogin('llm-pi-ai', login)

    await expect(ctx.llm.remoteLoginApiKey('llm-pi-ai', 'p', 'k', new AbortController().signal))
      .rejects.toMatchObject({ code: 'llm/login-rejected', message: 'plain refusal' })
  })
})
