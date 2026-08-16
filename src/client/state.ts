/**
 * 看板形态状态：悬浮窗 / 停靠右侧 / 并存 / 隐藏，localStorage 持久化。
 *
 * 单一事实源（localStorage `dsh.agentBoard.v1`）+ 文档级自定义事件总线：
 * 悬浮窗菜单、停靠面板菜单、设置页选择、侧边栏 foot 按钮都走同一通道，
 * 任何一处切换，其余 UI 同步刷新。
 * @module @dsh-external/dsh-agent-board/client/state
 */

/** 看板形态：悬浮窗 / 停靠右侧面板 / 两者并存。 */
export type BoardMode = 'floating' | 'docked' | 'both'

/** 持久化的看板状态（兼容旧版：top/right/visible/collapsed 语义不变）。 */
export interface BoardState {
  /** 悬浮窗位置（px，距视口上/右边缘）。 */
  top: number
  right: number
  /** 总开关：false = 全部隐藏（右下角召唤按钮出现）。 */
  visible: boolean
  /** 悬浮窗折叠为单行条。 */
  collapsed: boolean
  /** 形态：悬浮窗 / 停靠右侧 / 并存。 */
  mode: BoardMode
  /** 停靠面板宽度（px）。 */
  dockedWidth: number
  /** 停靠面板折叠为 0 宽（右侧出现展开按钮）。 */
  dockedCollapsed: boolean
}

/** localStorage key for the board state. */
export const LS_KEY = 'dsh.agentBoard.v1'

/** 停靠面板宽度范围与默认值。 */
export const DOCKED_DEFAULT_WIDTH = 300
export const DOCKED_MIN_WIDTH = 220
export const DOCKED_MAX_WIDTH = 520

/** 侧边栏 foot 按钮的可见性切换事件（与旧版同名，兼容）。 */
export const TOGGLE_EVENT = 'dsh.agentBoard.toggle'

/** 形态变更事件（detail: { mode?, visible? }，缺省字段保持不变）。 */
export const MODE_EVENT = 'dsh.agentBoard.mode'

/** 默认状态。 */
export const DEFAULT_STATE: BoardState = {
  top: 64,
  right: 16,
  visible: true,
  collapsed: false,
  mode: 'floating',
  dockedWidth: DOCKED_DEFAULT_WIDTH,
  dockedCollapsed: false,
}

export function loadState(): BoardState {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<BoardState>
      const mode: BoardMode = parsed.mode === 'docked' || parsed.mode === 'both' ? parsed.mode : 'floating'
      return {
        top: typeof parsed.top === 'number' ? parsed.top : DEFAULT_STATE.top,
        right: typeof parsed.right === 'number' ? parsed.right : DEFAULT_STATE.right,
        visible: parsed.visible !== false,
        collapsed: parsed.collapsed === true,
        mode,
        dockedWidth: typeof parsed.dockedWidth === 'number'
          ? Math.min(DOCKED_MAX_WIDTH, Math.max(DOCKED_MIN_WIDTH, parsed.dockedWidth))
          : DOCKED_DEFAULT_WIDTH,
        dockedCollapsed: parsed.dockedCollapsed === true,
      }
    }
  } catch { /* corrupted state falls back to defaults */ }
  return { ...DEFAULT_STATE }
}

export function saveState(state: BoardState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
  } catch { /* storage full/blocked: persistence is best-effort */ }
}

/** 广播一次形态变更（悬浮窗菜单 / 停靠面板菜单 / 设置页共用）。 */
export function emitModeChange(mode: BoardMode, visible: boolean): void {
  document.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: { mode, visible } }))
}

/** 广播一次可见性切换（侧边栏 foot 按钮）。 */
export function emitToggle(): void {
  document.dispatchEvent(new Event(TOGGLE_EVENT))
}
