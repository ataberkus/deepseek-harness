/**
 * LM Studio's stable OpenAI-compatible route defaults.
 *
 * The endpoint and protocol are documented product defaults, while the
 * placeholder key exists only because pi-ai requires a non-empty key for its
 * OpenAI client even when a local LM Studio server does not authenticate.
 *
 * @module dsh-llm-pi-ai/lmstudio
 */

/** LM Studio provider route key and settings profile key. */
export const LM_STUDIO_PROVIDER = 'lmstudio'

/** Display name used by provider directories and model selectors. */
export const LM_STUDIO_DISPLAY_NAME = 'LM Studio'

/** OpenAI Chat Completions protocol served by LM Studio's compatibility endpoint. */
export const LM_STUDIO_API = 'openai-completions'

/** Default local LM Studio OpenAI-compatible endpoint. */
export const LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1'

/** Non-secret key pi-ai needs when LM Studio authentication is not configured. */
export const LM_STUDIO_PLACEHOLDER_API_KEY = 'lm-studio'
