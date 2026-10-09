/**
 * Plugin configuration for the local workspace-checkpoint provider.
 * Retention and exclusion are restated in composition YAML; the loader schema
 * (`LocalWorkspaceCheckpoint.Config`) has no hidden defaults for those fields.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local/src/config
 */

/** Deployment-varying local provider settings. */
export interface Config {
  /** Whether automatic workspace capture and recovery admission are enabled. Defaults to false. */
  enabled?: boolean
  /** Object-store root. When omitted, `{dshHome}/workspace-checkpoints`. */
  objectRoot?: string
  /** Harness-home override used when `objectRoot` is omitted. */
  dshHome?: string
  /** Hard cap on stored blob bytes. Capture above this is fail-soft unavailable. */
  maxTotalBytes: number
  /** Glob patterns skipped by capture and restore planning. */
  excludeGlobs: string[]
  /** Extra `buildManifest` attempts after `CHECKPOINT_CONCURRENT_WRITE`. */
  captureRetryCount: number
  /** Delay between concurrent-write retries, in milliseconds. */
  captureRetryDelayMs: number
}
