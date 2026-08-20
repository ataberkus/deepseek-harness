// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import type { SessionNode } from '../src/client/tree.ts'
import { SessionNodeItem } from '../src/client/rows/Rows.tsx'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as never
const sid = (id: string) => id as SessionId

function node(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    id: sid('session'),
    title: '编辑分支',
    blank: false,
    running: false,
    runningSubagentCount: 0,
    completed: false,
    updatedAt: 0,
    ...overrides,
  }
}

function renderRows(values: readonly SessionNode[]) {
  return render(
    <div>
      {values.map(value => (
        <SessionNodeItem
          key={value.id}
          node={value}
          currentId={undefined}
          now={0}
          onOpen={vi.fn()}
          onRename={vi.fn()}
          onFork={vi.fn()}
          onArchive={vi.fn()}
          t={t}
        />
      ))}
    </div>,
  )
}

describe('checkpoint branch rows', () => {
  it('shows a checkpoint label without hiding the parent branch title', () => {
    renderRows([
      node({ id: sid('parent'), title: '原始会话' }),
      node({ id: sid('child'), title: '编辑分支', checkpointLabelIndex: 0 }),
    ])

    expect(screen.getByText('原始会话')).toBeTruthy()
    expect(screen.getByText('编辑分支')).toBeTruthy()
    expect(screen.getByText('检查点 0')).toBeTruthy()
  })

  it('keeps an unrestorable branch readable while showing its workspace diagnostic', () => {
    renderRows([node({ workspaceResumable: false })])

    expect(screen.getByText('编辑分支')).toBeTruthy()
    expect(screen.getByText('对话可查看，但工作区文件无法恢复')).toBeTruthy()
  })
})
