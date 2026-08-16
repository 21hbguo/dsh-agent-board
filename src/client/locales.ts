/**
 * `agent-board` namespace dictionaries (会话页「子代理」tab 标签等文案)。
 * 模式照 ui-trajectory/src/client/locales.ts：NS + 键集类型 + LocaleNamespaceMap
 * 合并 + zh/en 字典（zh 为键集事实源）。
 * @module @dsh-external/dsh-agent-board/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'agent-board'

/** The agent-board dictionary key set (the source of truth for both locales). */
export type AgentBoardKey =
  | 'view.subagents'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The agent-board view tab label. */
    'agent-board': AgentBoardKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<AgentBoardKey, string> = {
  'view.subagents': '子代理',
}

/** English dictionary. */
export const en: Record<AgentBoardKey, string> = {
  'view.subagents': 'Subagents',
}
