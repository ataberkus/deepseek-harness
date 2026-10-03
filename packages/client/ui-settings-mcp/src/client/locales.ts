/** Locale bundles for the MCP fleet's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type McpSettingsLocaleKey =
  | 'title' | 'description' | 'summaryEmpty' | 'summaryCount'
  | 'servers' | 'empty' | 'enabled' | 'transport' | 'transportStdio' | 'transportHttp'
  | 'addTitle' | 'updateTitle' | 'name' | 'nameHint' | 'command' | 'commandHint'
  | 'args' | 'argsHint' | 'url' | 'urlHint' | 'add' | 'update' | 'cancel'
  | 'edit' | 'remove' | 'editAction' | 'removeAction' | 'conflicted'
  | 'nameRequired' | 'nameInvalid' | 'commandRequired' | 'urlRequired' | 'urlInvalid'
  | 'unavailable' | 'readOnly' | 'saveFailed' | 'save' | 'saving'

/** English copy. */
export const en: Record<McpSettingsLocaleKey, string> = {
  title: 'MCP servers',
  description: 'Choose the Model Context Protocol servers this profile mounts.',
  summaryEmpty: 'No MCP servers configured.',
  summaryCount: '{count} MCP servers configured.',
  servers: 'Servers',
  empty: 'No servers yet. Add the first one below.',
  enabled: 'Enabled',
  transport: 'Transport',
  transportStdio: 'stdio',
  transportHttp: 'HTTP',
  addTitle: 'Add a server',
  updateTitle: 'Update {name}',
  name: 'Name',
  nameHint: 'Namespaces the tools as mcp__<name>__<tool>; up to 32 letters, digits, underscore, or hyphen.',
  command: 'Command',
  commandHint: 'Executable the Host starts for a stdio server.',
  args: 'Arguments',
  argsHint: 'One argument per line.',
  url: 'Endpoint',
  urlHint: 'Streamable HTTP endpoint of the server.',
  add: 'Add',
  update: 'Update',
  cancel: 'Cancel',
  edit: 'Edit {name}',
  remove: 'Remove {name}',
  editAction: 'Edit',
  removeAction: 'Remove',
  conflicted: 'Another writer changed these servers; the draft was kept. Discard it to load the stored servers.',
  nameRequired: 'Enter a server name.',
  nameInvalid: 'Use up to 32 letters, digits, underscores, or hyphens.',
  commandRequired: 'Enter the command a stdio server starts.',
  urlRequired: 'Enter the server endpoint.',
  urlInvalid: 'Enter an http or https URL.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  save: 'Save',
  saving: 'Saving…',
}

/** Simplified Chinese copy. */
export const zh: Record<McpSettingsLocaleKey, string> = {
  title: 'MCP 服务器',
  description: '选择本 profile 挂载的模型上下文协议（MCP）服务器。',
  summaryEmpty: '尚未配置 MCP 服务器。',
  summaryCount: '已配置 {count} 个 MCP 服务器。',
  servers: '服务器',
  empty: '还没有服务器。在下方添加第一个。',
  enabled: '已启用',
  transport: '传输方式',
  transportStdio: 'stdio',
  transportHttp: 'HTTP',
  addTitle: '添加服务器',
  updateTitle: '更新 {name}',
  name: '名称',
  nameHint: '工具命名为 mcp__<名称>__<工具>；最多 32 个字母、数字、下划线或连字符。',
  command: '命令',
  commandHint: 'Host 为 stdio 服务器启动的可执行文件。',
  args: '参数',
  argsHint: '每行一个参数。',
  url: '接口地址',
  urlHint: '服务器的 Streamable HTTP 接口地址。',
  add: '添加',
  update: '更新',
  cancel: '取消',
  edit: '编辑 {name}',
  remove: '移除 {name}',
  editAction: '编辑',
  removeAction: '移除',
  conflicted: '其他写入方改动了这些服务器，草稿已保留。放弃草稿即可载入已存服务器。',
  nameRequired: '请填写服务器名称。',
  nameInvalid: '最多 32 个字母、数字、下划线或连字符。',
  commandRequired: '请填写 stdio 服务器启动的命令。',
  urlRequired: '请填写服务器接口地址。',
  urlInvalid: '请填写 http 或 https 地址。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  readOnly: '本部署的设置为只读。',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  save: '保存',
  saving: '保存中…',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: McpSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
