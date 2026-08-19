/**
 * Plugin configuration for the local workspace-checkpoint provider.
 * Retention and exclusion are restated in composition YAML; this schema has
 * no hidden defaults for those fields.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/config
 */

import z from '@deepseek-ai/schemastery'

/** Deployment-varying local provider settings. */
export interface Config {
  /** Object-store root. When omitted, `{dshHome}/workspace-checkpoints`. */
  objectRoot?: string
  /** Harness-home override used when `objectRoot` is omitted. */
  dshHome?: string
  /** Hard cap on stored blob bytes. Capture above this is fail-soft unavailable. */
  maxTotalBytes: number
  /** Glob patterns matched against slash-separated relative paths. */
  excludeGlobs: string[]
  /** Extra `buildManifest` attempts after `CHECKPOINT_CONCURRENT_WRITE`. */
  captureRetryCount: number
  /** Delay between concurrent-write retries, in milliseconds. */
  captureRetryDelayMs: number
}

/** Loader schema. `objectRoot` and `dshHome` are optional; every other field is required. */
export const Config: z<Config> = z.object({
  objectRoot: z.string(),
  dshHome: z.string(),
  maxTotalBytes: z.number().required(),
  excludeGlobs: z.array(z.string()).required(),
  captureRetryCount: z.number().required(),
  captureRetryDelayMs: z.number().required(),
})
