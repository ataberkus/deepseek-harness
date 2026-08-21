/**
 * Antigravity Cloud Code Assist `streamGenerateContent` request body. Message and tool
 * conversion reuses pi-ai's Gemini GenerateContent mapper; this module wraps that
 * payload in the Antigravity agent envelope (`project`, `requestId`, `request`, `model`, `userAgent`, `requestType`).
 *
 * @module dsh-llm-pi-ai/google-antigravity/request
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { convertMessages, convertTools } from '@earendil-works/pi-ai/api/google-shared'
import type { Api, Context, Model, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai'

/** Wire thinking level Cloud Code Assist accepts for reasoning models. */
export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'

/** Antigravity Cloud Code Assist generate-content envelope. */
export interface AntigravityRequest {
  project: string
  requestId: string
  request: {
    contents: unknown[]
    systemInstruction?: {
      role?: string
      parts: Array<{ text: string }>
    }
    tools?: unknown[]
    toolConfig?: {
      functionCallingConfig: {
        mode: string
        allowedFunctionNames?: string[]
      }
    }
    generationConfig?: {
      temperature?: number
      maxOutputTokens?: number
      thinkingConfig?: {
        includeThoughts?: boolean
        thinkingLevel?: GeminiThinkingLevel
        thinkingBudget?: number
      }
    }
    labels?: Record<string, string>
    sessionId?: string
  }
  model: string
  userAgent: 'antigravity'
  requestType: 'agent'
}

const MASK_63BIT = (1n << 63n) - 1n

function generateSessionId(context: Context): string {
  for (const message of context.messages) {
    if (message.role === 'user') {
      let text = ''
      if (typeof message.content === 'string') {
        text = message.content
      } else if (Array.isArray(message.content)) {
        const textPart = message.content.find(p => p.type === 'text')
        if (textPart && 'text' in textPart && typeof textPart.text === 'string') {
          text = textPart.text
        }
      }
      if (text.trim().length > 0) {
        const hash = createHash('sha256').update(text).digest()
        let val = 0n
        for (let i = 0; i < 8; i++) {
          val = (val << 8n) | BigInt(hash[i] ?? 0)
        }
        return `-${(val & MASK_63BIT).toString()}`
      }
    }
  }
  const bytes = randomBytes(8)
  let val = 0n
  for (const b of bytes) {
    val = (val << 8n) | BigInt(b)
  }
  return `-${(val & MASK_63BIT).toString()}`
}

/**
 * Build the Antigravity POST body for one turn.
 * @param model - hosted Antigravity model.
 * @param context - harness-converted pi-ai context.
 * @param projectId - Cloud Code Assist project from the OAuth credential.
 * @param options - sampling and reasoning from `streamSimple`.
 * @returns JSON-serializable request body.
 */
export function buildAntigravityRequest(
  model: Model<Api>,
  context: Context,
  projectId: string,
  options?: SimpleStreamOptions,
): AntigravityRequest {
  const conversionModel = { ...model, api: 'google-generative-ai' } as Model<'google-generative-ai'>
  const contents = convertMessages(conversionModel, context)
  const isClaude = model.id.toLowerCase().includes('claude')
  const trajectoryId = randomUUID()
  const agentId = randomUUID()
  const sessionId = generateSessionId(context)
  const requestId = `agent/${agentId}/${Date.now()}/${trajectoryId}/2`

  const innerRequest: AntigravityRequest['request'] = {
    contents,
    sessionId,
    labels: {
      last_step_index: '1',
      trajectory_id: trajectoryId,
      used_claude: String(isClaude),
      used_claude_conservative: String(isClaude),
    },
  }

  if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
    innerRequest.systemInstruction = {
      role: 'user',
      parts: [{ text: context.systemPrompt }],
    }
  }

  if (context.tools !== undefined && context.tools.length > 0) {
    const converted = convertTools(context.tools, true)
    if (converted !== undefined) {
      innerRequest.tools = converted
      innerRequest.toolConfig = {
        functionCallingConfig: {
          mode: 'VALIDATED',
        },
      }
    }
  }

  const generationConfig: NonNullable<AntigravityRequest['request']['generationConfig']> = {}
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature
  if (options?.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens

  if (model.reasoning) {
    const thinking = thinkingFromOptions(options)
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      ...thinking,
    }
  }

  if (Object.keys(generationConfig).length > 0) {
    innerRequest.generationConfig = generationConfig
  }

  return {
    project: projectId,
    requestId,
    request: innerRequest,
    model: model.id,
    userAgent: 'antigravity',
    requestType: 'agent',
  }
}

function thinkingFromOptions(
  options: SimpleStreamOptions | undefined,
): { thinkingLevel?: GeminiThinkingLevel } {
  if (options?.reasoning !== undefined) {
    return {
      thinkingLevel: mapThinkingLevel(options.reasoning),
    }
  }
  return {}
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
    default:
      return 'HIGH'
  }
}
