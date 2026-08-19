/**
 * Local workspace-checkpoint provider: Harness-home object store, manifest
 * capture, and journaled restore.
 * @module @deepseek-ai/dsh-workspace-checkpoint-local
 */

export { hashCanonicalJson, hashFile } from './hash.ts'
export { buildManifest, fileStatsRaced, throwIfFileRaced } from './manifest.ts'
export type { ManifestBuildOptions } from './manifest.ts'
export { canonicalizeCwd, fromManifestPath, isContained, toManifestPath } from './paths.ts'
