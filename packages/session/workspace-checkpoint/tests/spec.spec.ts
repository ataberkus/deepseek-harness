import { describe, expect, it } from 'vitest'
import { CheckpointId } from '../src/types.ts'
import { workspaceCheckpointDomainSpec } from '../src/spec.ts'

describe('workspaceCheckpointDomainSpec', () => {
  it('declares the durable metadata domain', () => {
    expect(workspaceCheckpointDomainSpec.name).toBe('workspace_checkpoint')
    expect(workspaceCheckpointDomainSpec.version).toBe(0)
    expect(Object.keys(workspaceCheckpointDomainSpec.tables)).toEqual([
      'checkpoints',
      'sessions',
    ])
  })

  it('brands checkpoint ids without rewriting the string', () => {
    expect(CheckpointId('cp_1')).toBe('cp_1')
  })
})
