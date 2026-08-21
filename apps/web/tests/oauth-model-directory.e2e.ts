// Real Web composition regression: a completed Antigravity OAuth login persists a
// credential, registers its hosted route, forwards the topology event, and refreshes
// an already-open model picker. Google and Cloud Code Assist HTTP plus the loopback
// callback are deterministic; no model request or real credential is used.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  connectFreshWorkspace,
  newEnglishPage,
  saveFailureShot,
} from './support.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'

const SEED_PROVIDER = 'oauth-e2e-seed'
const SEED_MODEL = 'oauth-e2e-model'
const ACCESS_TOKEN = 'oauth-e2e-access'
const REFRESH_TOKEN = 'oauth-e2e-refresh'

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

describe('web e2e: Antigravity OAuth refreshes an open model directory', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let restoreFetch: (() => void) | undefined
  let stopOpenUrl: (() => void) | undefined
  let agentHandle: { dispose(): Promise<void> } | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        [SEED_PROVIDER]: {
          displayName: 'OAuth E2E Seed',
          api: 'openai-completions',
          baseURL: 'https://oauth-e2e.invalid/v1',
          models: [{ id: SEED_MODEL, name: 'OAuth E2E Seed Model' }],
        },
      },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url === 'https://oauth2.googleapis.com/token') {
        return response({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
        })
      }
      if (url.includes('cloudcode-pa.googleapis.com') && url.includes('loadCodeAssist')) {
        return response({
          currentTier: { id: 'free-tier' },
          cloudaicompanionProject: 'oauth-e2e-project',
        })
      }
      return originalFetch(input, init)
    }
    restoreFetch = () => { globalThis.fetch = originalFetch }

    stopOpenUrl = scaffold.ctx.on('commands/open-url', (authUrl: string) => {
      const authorize = new URL(authUrl)
      const redirectUri = authorize.searchParams.get('redirect_uri')
      const state = authorize.searchParams.get('state')
      if (redirectUri === null || state === null) throw new Error('Gemini OAuth authorize URL omitted its callback state')
      void originalFetch(
        `${redirectUri}?code=oauth-e2e-code&state=${encodeURIComponent(state)}`,
      ).then(callback => callback.body?.cancel()).catch(() => undefined)
    })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    stopOpenUrl?.()
    restoreFetch?.()
    await agentHandle?.dispose()
    await browser?.close()
    await scaffold?.close()
  })

  it('refreshes the loaded picker after the hosted login commits', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-antigravity-oauth-model-directory'))

    const trigger = page.getByRole('button', { name: /Select model/ }).first()
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 })

    const agent = await scaffold.ctx.agents.create({
      sessionId: SessionId('oauth-model-directory'),
      meta: { cwd: scaffold.workspaceCwd },
    })
    agentHandle = agent
    const login = await scaffold.ctx.commands.execute(
      agent.agent,
      '/login google-antigravity',
      [],
      AbortSignal.timeout(15_000),
    )
    expect(login?.result).toEqual({
      kind: 'success',
      text: 'Signed in to Antigravity. Select a google-antigravity model to use the Antigravity subscription.',
    })

    const hostModels = await scaffold.ctx.apiProxy.llm.models({
      rpcId: RpcId('oauth-e2e-models'),
      payload: {},
    })
    if (!hostModels.result.ok) throw new Error(`llm.models failed: ${hostModels.result.error.message}`)
    expect(hostModels.result.value.groups.find(group => group.id === 'google-antigravity')?.models)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'gemini-3.7-flash' })]))

    await page.getByRole('menuitemradio', { name: 'Gemini 3.7 Flash', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 })
    expect((await page.content()).includes(ACCESS_TOKEN)).toBe(false)
    expect((await page.content()).includes(REFRESH_TOKEN)).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
