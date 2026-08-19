/**
 * Gemini CLI User-Agent and Cloud Code Assist client metadata. Cloud Code
 * Assist rate-limits clients it does not recognize as Gemini CLI.
 *
 * @module dsh-llm-pi-ai/google-gemini-cli/headers
 */

import { GOOGLE_GEMINI_CLI_USER_AGENT_VERSION } from './constants.ts'

/**
 * Headers the unofficial Cloud Code Assist backend expects from Gemini CLI.
 * @param modelId - model segment of the User-Agent; `login` during OAuth.
 * @returns User-Agent plus Client-Metadata.
 */
export function geminiCliHeaders(modelId = 'gemini-2.5-flash'): Record<string, string> {
  const platform = process.platform
  const arch = process.arch
  return {
    'User-Agent': `GeminiCLI/${GOOGLE_GEMINI_CLI_USER_AGENT_VERSION}/${modelId} (${platform}; ${arch}; terminal)`,
    'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
  }
}
