/**
 * Antigravity User-Agent and Cloud Code Assist request headers.
 *
 * @module dsh-llm-pi-ai/google-antigravity/headers
 */

import { GOOGLE_ANTIGRAVITY_CL, GOOGLE_ANTIGRAVITY_VERSION } from './constants.ts'

/**
 * Build the Antigravity User-Agent string.
 * @returns User-Agent string identifying this client as Antigravity hub.
 */
export function antigravityUserAgent(): string {
  const version = process.env.PI_AI_ANTIGRAVITY_VERSION || GOOGLE_ANTIGRAVITY_VERSION
  const cl = process.env.PI_AI_ANTIGRAVITY_CL || GOOGLE_ANTIGRAVITY_CL
  const osType = process.env.PI_AI_ANTIGRAVITY_OS || process.platform
  const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || process.arch
  return `antigravity/hub/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${cl})`
}

/**
 * Headers the unofficial Antigravity Cloud Code Assist backend expects.
 * @param modelId - model identifier; adds anthropic-beta header for Claude models.
 * @returns User-Agent and optional provider beta headers.
 */
export function antigravityHeaders(modelId = 'gemini-3.7-flash'): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': antigravityUserAgent(),
  }
  if (modelId.toLowerCase().includes('claude')) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  }
  return headers
}
