// Real Web composition regression: selecting `/login` opens the hosted OAuth
// provider picker, commits Antigravity through the real command path, and
// refreshes an already-open model picker. Google and Cloud Code Assist HTTP
// plus the loopback callback are deterministic; no model request or real
// credential is used.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'

import {
  connectFreshWorkspace,
  newEnglishPage,
  saveFailureShot,
} from './support.ts'
import {
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'

const SEED_PROVIDER = 'oauth-e2e-seed'
const SEED_MODEL = 'oauth-e2e-model'
const ACCESS_TOKEN = 'oauth-e2e-access'
const REFRESH_TOKEN = 'oauth-e2e-refresh'
const MODE = webSnapshotMode()
const LOGIN_PICKER_EXPECTED = fileURLToPath(
  new URL('./snapshots/oauth-model-directory/login-picker.expected.md', import.meta.url),
)

type ConsoleTripwire = { warnings: string[]; pageErrors: string[] }

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

describe('web e2e: hosted OAuth provider picker refreshes model directory', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ConsoleTripwire
  let restoreFetch: (() => void) | undefined
  let stopOpenUrl: (() => void) | undefined

  beforeAll(async () => {
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

    scaffold = await launchWebScaffold({})
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: {
        [SEED_PROVIDER]: {
          displayName: 'OAuth E2E Seed',
          api: 'openai-completions',
          baseURL: 'https://oauth-e2e.invalid/v1',
          models: [{ id: SEED_MODEL, name: 'OAuth E2E Seed Model' }],
        },
      },
    })

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
    await browser?.close()
    await scaffold?.close()
  })

  it('selects Antigravity from /login and refreshes the loaded model picker', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-antigravity-oauth-model-directory'))

    const input = page.locator('textarea').first()
    await input.fill('/')
    const slashMenu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await slashMenu.waitFor({ timeout: 10_000 })
    await slashMenu.getByRole('option', { name: /login/i }).click()

    const loginPicker = page.getByRole('listbox', { name: '/login matches' })
    await loginPicker.waitFor({ timeout: 10_000 })
    expect(await loginPicker.getByRole('option').allTextContents()).toEqual([
      'OpenAI CodexChatGPT subscription',
      'CursorCursor subscription',
      'AntigravityGoogle Cloud Code Assist subscription',
    ])
    const aria = await captureStableAria(page, '[role="listbox"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(LOGIN_PICKER_EXPECTED, aria, MODE)
    await loginPicker.getByRole('option', { name: /Antigravity/ }).click()

    await expect.poll(() => {
      const events = scaffold.ctx.sessions.list().flatMap(session => session.snapshotEvents())
      const run = events.find(event => event.type === 'command/run' && event.data.name === 'login')
      if (run?.type !== 'command/run') return undefined
      const done = events.find(event => event.type === 'command/done' && event.data.commandId === run.data.commandId)
      if (done?.type !== 'command/done') return undefined
      if (done.data.kind === 'error') throw new Error(`login command failed: ${done.data.text}`)
      return done.data
    }, { timeout: 15_000 }).toMatchObject({ kind: 'success' })
    await expect.poll(
      () => scaffold.ctx.llm.listProviders().some(provider => provider.id === 'google-antigravity'),
      { timeout: 15_000 },
    ).toBe(true)

    const trigger = page.getByRole('button', { name: /Select model/ }).first()
    await trigger.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 })

    const antigravityModels = await scaffold.ctx.llm.listModels('google-antigravity')
    expect(antigravityModels).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gemini-3.7-flash' })]),
    )

    await page.getByRole('menuitemradio', { name: 'Gemini 3.7 Flash', exact: true })
      .waitFor({ state: 'visible', timeout: 15_000 })
    expect((await page.content()).includes(ACCESS_TOKEN)).toBe(false)
    expect((await page.content()).includes(REFRESH_TOKEN)).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
