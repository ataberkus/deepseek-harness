/**
 * Cloud Code Assist `streamGenerateContent` request body. Message and tool
 * conversion reuses pi-ai's Gemini GenerateContent mapper; this module only
 * wraps that payload in the CCA envelope (`project`, `model`, `request`).
 *
 * @module dsh-llm-pi-ai/google-gemini-cli/request
 */

import { convertMessages, convertTools } from '@earendil-works/pi-ai/api/google-shared'
import type { Api, Context, Model, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai'

/** Wire thinking level Cloud Code Assist accepts for Gemini 3. */
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'

/** Cloud Code Assist generate-content envelope. */
export interface CloudCodeAssistRequest {
  project: string
  model: string
  request: {
    contents: unknown[]
    systemInstruction?: { parts: { text: string }[] }
    generationConfig?: {
      maxOutputTokens?: number
      temperature?: number
      thinkingConfig?: {
        includeThoughts: boolean
        thinkingLevel?: GeminiThinkingLevel
        thinkingBudget?: number
      }
    }
    tools?: { functionDeclarations: Record<string, unknown>[] }[]
  }
}

/**
 * Build the Cloud Code Assist POST body for one turn.
 * @param model - hosted Gemini CLI model.
 * @param context - harness-converted pi-ai context.
 * @param projectId - Cloud Code Assist project from the OAuth credential.
 * @param options - sampling and reasoning from `streamSimple`.
 * @returns JSON-serializable request body.
 */
export function buildCloudCodeAssistRequest(
  model: Model<Api>,
  context: Context,
  projectId: string,
  options?: SimpleStreamOptions,
): CloudCodeAssistRequest {
  const conversionModel = { ...model, api: 'google-generative-ai' } as Model<'google-generative-ai'>
  const contents = convertMessages(conversionModel, context)
  const request: CloudCodeAssistRequest['request'] = { contents }
  if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
    request.systemInstruction = { parts: [{ text: context.systemPrompt }] }
  }
  if (context.tools !== undefined && context.tools.length > 0) {
    const tools = convertTools(context.tools)
    /* v8 ignore next -- convertTools omits the array only for an empty tool list we already skipped. */
    if (tools !== undefined) request.tools = tools
  }
  const generationConfig: NonNullable<CloudCodeAssistRequest['request']['generationConfig']> = {}
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature
  if (options?.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens
  if (model.reasoning) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      ...thinkingFromOptions(options),
    }
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  return {
    project: projectId,
    model: model.id,
    request,
  }
}

function thinkingFromOptions(
  options: SimpleStreamOptions | undefined,
): { thinkingLevel?: GeminiThinkingLevel; thinkingBudget?: number } {
  const level = options?.reasoning
  if (level === undefined) return {}
  const budgets = options?.thinkingBudgets
  if (budgets !== undefined && level !== 'xhigh' && level !== 'max') {
    const budget = budgets[level]
    if (budget !== undefined) return { thinkingBudget: budget }
  }
  return { thinkingLevel: mapThinkingLevel(level) }
}

function mapThinkingLevel(level: ThinkingLevel): GeminiThinkingLevel {
  switch (level) {
    case 'minimal':
      return 'MINIMAL'
    case 'low':
      return 'LOW'
    case 'medium':
      return 'MEDIUM'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'HIGH'
  }
}
