/** Web dictionaries for the composer's prompt-enhancement control. */

/** Locale namespace owned by the prompt-enhancement control. */
export const NS = 'prompt-enhance'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  enhance: '增强提示词',
  cancel: '取消增强',
  command: '增强输入框中的提示词',
  enhancing: '正在增强提示词…',
  progress: '正在用 {model} 增强…',
  progressStep: '正在用 {model} 增强 · {step}…',
  'step.read': '读取 {target}',
  'step.grep': '搜索“{target}”',
  'step.glob': '列出 {target}',
  done: '提示词已增强',
  undo: '撤销',
  failed: '提示词增强失败：{message}',
  'shortcut.unavailable': '请先在输入框中写下草稿',
} satisfies Record<string, string>

/** Prompt-enhancement locale key union. */
export type PromptEnhanceKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Composer prompt-enhancement copy. */
    'prompt-enhance': PromptEnhanceKey
  }
}

/** English dictionary checked against the Chinese key set. */
export const en = {
  enhance: 'Enhance prompt',
  cancel: 'Cancel enhancing',
  command: 'Enhance the composer prompt',
  enhancing: 'Enhancing prompt…',
  progress: 'Enhancing with {model}…',
  progressStep: 'Enhancing with {model} · {step}…',
  'step.read': 'reading {target}',
  'step.grep': 'searching "{target}"',
  'step.glob': 'listing {target}',
  done: 'Prompt enhanced',
  undo: 'Undo',
  failed: 'Prompt enhancement failed: {message}',
  'shortcut.unavailable': 'Write a draft in the composer first',
} satisfies Record<PromptEnhanceKey, string>
