/**
 * @dsh-external/dsh-agent-board — 浏览器半区：Agent 看板（双形态）。
 *
 * 两种常驻形态，可切换、可并存、可隐藏（设置页或面板内菜单）：
 *  - 悬浮窗（floating，默认）：右上角可拖拽浮窗，点击标题折叠、× 隐藏；
 *  - 停靠右侧面板（docked）：AionUi 文件插件风格——在 shell 网格右侧追加
 *    一列轨道，内容左移而非遮挡；拖拽把手调宽（220–520px，双击复位 300px），
 *    标题点击折叠为 0 宽（右侧出现展开按钮）。
 *  - 并存（both）：两种同时显示。
 *
 * 形态切换入口：① 悬浮窗/停靠面板标题栏的 ▦ 菜单；② 设置 → 常规 →
 * 「Agent 看板」下拉；③ 侧边栏 foot「Agent 看板」按钮 = 显示/隐藏总开关。
 * 状态持久化 localStorage `dsh.agentBoard.v1`，事件总线统一广播。
 *
 * 数据流：轮询 `GET /api/agent-board/agents`（2s，标签页隐藏暂停）+ SSE
 * `GET /api/agent-board/stream` 即时信号；两种形态共用 tree.ts 渲染管线。
 * 全部渲染为 plain DOM——无 store、无 css modules。
 *
 * Failure policy: transport errors render an "offline" hint and keep the poll
 * alive; nothing throws (the web shell fails boot on apply throw).
 * @module @dsh-external/dsh-agent-board/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-slots SlotMap merge table (incl. ui-sidebar's
// 'sidebar.footer.action' declaration) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the settings slot contract (settings.general.item etc.)
// into this program — same pattern as ui-settings-general.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState } from 'react'
import type { AgentBoardSnapshot } from '../index.js'
import { DockedAgentBoard, type DockedBoardActions } from './docked.js'
import {
  emitModeChange,
  emitToggle,
  loadState,
  saveState,
  TOGGLE_EVENT,
  MODE_EVENT,
  FONT_MIN,
  FONT_MAX,
  type BoardMode,
  type BoardState,
} from './state.js'
import { loadViewed, markViewed, openBoardSession, renderBoardTree } from './tree.js'

/** Poll interval (ms) while the tab is visible. 2s：状态/动作切换的感知延迟
 *  主要来自此周期；更快需要事件推送（SSE），暂未做。 */
const POLL_MS = 2000

/** Toggle event fired by the sidebar footer action (see state.ts). */
const TOGGLE_EVENT_NAME = TOGGLE_EVENT

/** 悬浮窗与 App 之间的动作契约。 */
interface WidgetBoardActions {
  onOpen: (id: string, parentId?: string) => Promise<boolean>
  openModeMenu: (anchor: HTMLElement, onClose: () => void) => void
  /** 字号调节（delta ±1px）。 */
  onFontChange: (delta: number) => void
  onHide: () => void
  onCollapsedChange: (collapsed: boolean) => void
}

/** 全部样式（悬浮窗 + 模式菜单 + 停靠面板），一次性注入 <head>。
 *  停靠面板与菜单用 shell 主题令牌（--dsw-alias-*）着色、跟随 shell 明暗；
 *  令牌缺失时按 prefers-color-scheme 回退（浅色块在后，令牌定义时恒赢）。 */
const WIDGET_CSS = `
.swd-widget {
  position: fixed;
  z-index: 2147483647;
  width: 300px;
  max-height: 55vh;
  display: flex;
  flex-direction: column;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--ab-font, 11px);
  line-height: 1.6;
  color: #e6e6e6;
  background: rgba(17, 17, 20, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  user-select: none;
  overflow: hidden;
}
.swd-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  font-size: var(--ab-font, 11px);
  font-weight: 600;
  color: #9ad0ff;
  cursor: grab;
  white-space: nowrap;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.swd-title:active { cursor: grabbing; }
.swd-title-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
.swd-close {
  cursor: pointer;
  color: #9aa0a6;
  border: none;
  background: none;
  font-size: calc(var(--ab-font, 11px) + 2px);
  line-height: 1;
  padding: 0 4px;
}
.swd-close:hover { color: #fff; }
.swd-mode-btn {
  cursor: pointer;
  color: #9aa0a6;
  border: none;
  background: none;
  font-size: calc(var(--ab-font, 11px) + 1px);
  line-height: 1;
  padding: 0 4px;
}
.swd-mode-btn:hover { color: #fff; }
.swd-font-btn {
  cursor: pointer;
  color: #9aa0a6;
  border: none;
  background: none;
  font-size: calc(var(--ab-font, 11px) + 1px);
  line-height: 1;
  padding: 0 3px;
  width: 16px;
  text-align: center;
}
.swd-font-btn:hover { color: #fff; }
.swd-body { overflow-y: auto; padding: 6px 8px; }
.swd-tree { margin: 0; padding: 0; list-style: none; }
/* 子代理层级：每层 28px 缩进 + 树线（根行有 ▸ 占位约 15px，加大缩进保证层级错开明显） */
.swd-tree ul { margin: 0; padding: 0 0 0 28px; list-style: none; border-left: 1px dashed rgba(154, 208, 255, 0.35); }
.swd-node {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 1.5px 0;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 4px;
}
.swd-node:hover { background: rgba(154, 208, 255, 0.12); }
/* 点击瞬间反馈：跳转渲染前先高亮（打开中） */
.swd-opening { background: rgba(154, 208, 255, 0.22); }
/* 跳转彻底失败：红色提示（会话可能已不存在） */
.swd-open-failed { background: rgba(248, 113, 113, 0.28); }
.swd-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(-0.5px); }
/* 状态色（实心 = 主 agent，空心 = 子代理） */
.swd-st-running { background: #4ade80; border-color: #4ade80; }
.swd-st-idle { background: #6b7280; border-color: #6b7280; }
.swd-st-stall { background: #f87171; border-color: #f87171; }
.swd-st-finished { background: #60a5fa; border-color: #60a5fa; }
/* 主 agent：实心圆（状态色填充） */
.swd-dot-root { border: 1.5px solid; box-shadow: 0 0 5px rgba(255, 255, 255, 0.25); }
/* 子代理：半透明填充 + 2px 实色描边（颜色面积大、深浅底色都一眼可见） */
.swd-dot-ring { border: 2px solid; }
.swd-st-running.swd-dot-ring { background: rgba(74, 222, 128, 0.4); box-shadow: 0 0 6px rgba(74, 222, 128, 0.6); }
.swd-st-finished.swd-dot-ring { background: rgba(96, 165, 250, 0.45); box-shadow: 0 0 7px rgba(96, 165, 250, 0.7); }
.swd-st-idle.swd-dot-ring { background: rgba(107, 114, 128, 0.45); box-shadow: 0 0 5px rgba(107, 114, 128, 0.45); }
.swd-st-stall.swd-dot-ring { background: rgba(248, 113, 113, 0.5); box-shadow: 0 0 7px rgba(248, 113, 113, 0.8); }
.swd-toggle { cursor: pointer; color: #9aa0a6; font-size: calc(var(--ab-font, 11px) - 2px); flex: none; width: 10px; text-align: center; }
.swd-toggle:hover { color: #fff; }
/* 完成态行：整体弱化，突出「已完成」而不抢 running 的注意力 */
.swd-finished-line { opacity: 0.62; }
.swd-tag {
  color: #0f172a;
  background: #60a5fa;
  border-radius: 3px;
  font-size: var(--ab-font-sub, 10px);
  font-weight: 700;
  padding: 0 4px;
  line-height: 1.4;
  flex: none;
}
.swd-id { color: #d7dde3; }
.swd-id-root { color: #9ad0ff; font-weight: 700; }
.swd-meta { color: #9aa0a6; margin-left: auto; padding-left: 8px; flex: none; white-space: nowrap; }
.swd-stall { color: #f87171; font-weight: 700; margin-left: auto; padding-left: 8px; flex: none; white-space: nowrap; }
.swd-offline { color: #fbbf24; text-align: center; padding: 4px 0; }
.swd-empty { color: #9aa0a6; text-align: center; padding: 4px 0; }
/* 答复节选：与状态同行（名字与状态之间），超长省略 */
.swd-excerpt-inline {
  color: #8b93a1;
  font-size: var(--ab-font-sub, 10px);
  flex: 1;
  min-width: 0;
  margin-left: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.swd-summon {
  position: fixed;
  right: 16px;
  bottom: 20px;
  z-index: 2147483647;
  cursor: pointer;
  font: var(--ab-font, 11px) ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #9ad0ff;
  background: rgba(17, 17, 20, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  padding: 4px 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.swd-summon:hover { color: #fff; }
.swd-action {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: #9aa0a6;
  border: none;
  background: none;
  padding: 6px 8px;
  width: 100%;
  font: calc(var(--ab-font, 11px) + 1px) ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.swd-action:hover { color: #e6e6e6; background: rgba(255, 255, 255, 0.06); border-radius: 6px; }
/* ===== 模式菜单（跟随 shell 主题令牌，缺失时浅色回退在后） ===== */
.swd-mode-menu {
  position: fixed;
  z-index: 2147483647;
  min-width: 160px;
  padding: 4px;
  font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  background: var(--dsw-alias-bg-overlay, rgba(17, 17, 20, 0.97));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}
.swd-mode-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  background: none;
  border: none;
  color: var(--dsw-alias-label-primary, #d7dde3);
  text-align: left;
  cursor: pointer;
  border-radius: 5px;
  font: inherit;
  white-space: nowrap;
}
.swd-mode-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(154, 208, 255, 0.14)); }
.swd-mode-item.active { color: var(--dsw-alias-brand-primary, #9ad0ff); font-weight: 700; }
/* ===== 停靠右侧面板（跟随 shell 主题令牌） ===== */
.swd-dock-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--ab-font, 11px);
  line-height: 1.6;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  background: var(--dsw-alias-bg-layer-1, rgba(17, 17, 20, 0.97));
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
}
.swd-dock-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  color: var(--dsw-alias-brand-primary, #9ad0ff);
  font-weight: 600;
  user-select: none;
  white-space: nowrap;
}
.swd-dock-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.swd-dock-title:hover { opacity: 0.85; }
.swd-dock-mode, .swd-dock-close {
  cursor: pointer;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  border: none;
  background: none;
  font-size: calc(var(--ab-font, 11px) + 1px);
  line-height: 1;
  padding: 0 4px;
}
.swd-dock-mode:hover, .swd-dock-close:hover { color: var(--dsw-alias-label-primary, #fff); }
.swd-dock-body { flex: 1; overflow-y: auto; padding: 6px 8px; }
.swd-dock-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 10px;
  z-index: 30;
  cursor: col-resize;
}
.swd-dock-handle::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--dsw-alias-border-l2, rgba(154, 208, 255, 0.35));
}
.swd-dock-handle:hover::after { background: var(--dsw-alias-brand-primary, rgba(154, 208, 255, 0.7)); }
.swd-dock-expand {
  position: fixed;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483647;
  cursor: pointer;
  font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-brand-primary, #9ad0ff);
  background: var(--dsw-alias-bg-overlay, rgba(17, 17, 20, 0.9));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  padding: 6px 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.swd-dock-expand:hover { color: var(--dsw-alias-label-primary, #fff); }
/* 我们改轨道瞬间禁用 shell 的 grid 过渡（拖拽/折叠跟手） */
.swd-instant-grid { transition: none !important; }
/* ===== 浅色主题（令牌缺失时按系统明暗回退） ===== */
@media (prefers-color-scheme: light) {
  .swd-widget {
    color: #1f2937;
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid rgba(0, 0, 0, 0.12);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  }
  .swd-title { color: #2563eb; border-bottom: 1px solid rgba(0, 0, 0, 0.08); }
  .swd-close { color: #6b7280; }
  .swd-close:hover { color: #111827; }
  .swd-mode-btn { color: #6b7280; }
  .swd-mode-btn:hover { color: #111827; }
  .swd-font-btn { color: #6b7280; }
  .swd-font-btn:hover { color: #111827; }
  .swd-tree ul { border-left: 1px dashed rgba(37, 99, 235, 0.3); }
  .swd-node:hover { background: rgba(37, 99, 235, 0.08); }
  .swd-opening { background: rgba(37, 99, 235, 0.16); }
  .swd-open-failed { background: rgba(220, 38, 38, 0.14); }
  /* 浅底用深一号状态色，保证对比度 */
  .swd-st-running { background: #16a34a; border-color: #16a34a; }
  .swd-st-idle { background: #6b7280; border-color: #6b7280; }
  .swd-st-stall { background: #dc2626; border-color: #dc2626; }
  .swd-st-finished { background: #2563eb; border-color: #2563eb; }
  .swd-st-running.swd-dot-ring { background: rgba(22, 163, 74, 0.3); box-shadow: 0 0 6px rgba(22, 163, 74, 0.45); }
  .swd-st-finished.swd-dot-ring { background: rgba(37, 99, 235, 0.32); box-shadow: 0 0 7px rgba(37, 99, 235, 0.5); }
  .swd-st-idle.swd-dot-ring { background: rgba(107, 114, 128, 0.3); box-shadow: 0 0 5px rgba(107, 114, 128, 0.3); }
  .swd-st-stall.swd-dot-ring { background: rgba(220, 38, 38, 0.35); box-shadow: 0 0 7px rgba(220, 38, 38, 0.55); }
  .swd-toggle { color: #6b7280; }
  .swd-toggle:hover { color: #111827; }
  .swd-tag { color: #fff; background: #2563eb; }
  .swd-id { color: #374151; }
  .swd-id-root { color: #2563eb; }
  .swd-meta { color: #6b7280; }
  .swd-stall { color: #dc2626; }
  .swd-offline { color: #b45309; }
  .swd-empty { color: #6b7280; }
  .swd-excerpt-inline { color: #6b7280; }
  .swd-summon {
    color: #2563eb;
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid rgba(0, 0, 0, 0.12);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }
  .swd-summon:hover { color: #1d4ed8; }
  .swd-action:hover { color: #111827; background: rgba(0, 0, 0, 0.05); }
  /* 令牌优先：浅色块中的令牌表达式同样以 var(--dsw-alias-*) 开头，
     令牌定义时（shell 明暗两套）恒取令牌值；未定义才用浅色兜底。 */
  .swd-mode-menu {
    color: var(--dsw-alias-label-primary, #1f2937);
    background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.97));
    border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  }
  .swd-mode-item { color: var(--dsw-alias-label-primary, #374151); }
  .swd-mode-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(37, 99, 235, 0.1)); }
  .swd-mode-item.active { color: var(--dsw-alias-brand-primary, #2563eb); }
  .swd-dock-col {
    color: var(--dsw-alias-label-primary, #1f2937);
    background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.97));
    border-left: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  }
  .swd-dock-header {
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
    color: var(--dsw-alias-brand-primary, #2563eb);
  }
  .swd-dock-mode, .swd-dock-close { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swd-dock-mode:hover, .swd-dock-close:hover { color: var(--dsw-alias-label-primary, #111827); }
  .swd-dock-handle::after { background: var(--dsw-alias-border-l2, rgba(37, 99, 235, 0.3)); }
  .swd-dock-handle:hover::after { background: var(--dsw-alias-brand-primary, rgba(37, 99, 235, 0.6)); }
  .swd-dock-expand {
    color: var(--dsw-alias-brand-primary, #2563eb);
    background: var(--dsw-alias-bg-overlay, rgba(255, 255, 255, 0.94));
    border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }
  .swd-dock-expand:hover { color: var(--dsw-alias-label-primary, #1d4ed8); }
}
`

let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = WIDGET_CSS
  document.head.appendChild(style)
}

/** 形态菜单条目。 */
interface ModeMenuItem { value: BoardMode | 'hidden'; label: string }

const MODE_MENU_ITEMS: readonly ModeMenuItem[] = [
  { value: 'floating', label: '◉ 悬浮窗' },
  { value: 'docked', label: '▥ 停靠右侧面板' },
  { value: 'both', label: '◉▥ 两者并存' },
  { value: 'hidden', label: '— 隐藏' },
]

/** 形态中文名（设置行下拉用）。 */
const MODE_LABELS: Record<BoardMode | 'hidden', string> = {
  floating: '悬浮窗',
  docked: '停靠右侧面板',
  both: '两者并存',
  hidden: '隐藏',
}

/** 当前形态（hidden = 隐藏）。 */
function currentModeValue(state: BoardState): BoardMode | 'hidden' {
  return state.visible ? state.mode : 'hidden'
}

/** 在锚点元素下方弹出形态菜单；选择即落盘并广播 MODE_EVENT。 */
function openModeMenu(anchor: HTMLElement, onClose: () => void): void {
  const state = loadState()
  const current = currentModeValue(state)
  const menu = document.createElement('div')
  menu.className = 'swd-mode-menu'
  for (const item of MODE_MENU_ITEMS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `swd-mode-item${item.value === current ? ' active' : ''}`
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      close()
      const s = loadState()
      if (item.value === 'hidden') {
        s.visible = false
      } else {
        s.mode = item.value
        s.visible = true
      }
      saveState(s)
      emitModeChange(s.mode, s.visible)
    })
    menu.appendChild(btn)
  }
  document.body.appendChild(menu)
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`
  menu.style.right = `${Math.max(4, window.innerWidth - rect.right)}px`
  const close = (): void => {
    document.removeEventListener('pointerdown', onPointer, true)
    window.removeEventListener('keydown', onKey)
    menu.remove()
    onClose()
  }
  const onPointer = (e: PointerEvent): void => {
    if (!menu.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('keydown', onKey)
}

/** 常驻悬浮窗：树形展示子代理层级 + 状态（数据由 AgentBoardApp 喂入）。 */
class AgentBoardWidget {
  private readonly ctx: ClientContext
  private readonly state: BoardState
  private readonly actions: WidgetBoardActions
  private readonly root: HTMLDivElement
  private readonly titleBarEl: HTMLDivElement
  private readonly titleTextEl: HTMLSpanElement
  private readonly bodyEl: HTMLDivElement
  private readonly treeEl: HTMLUListElement
  private readonly emptyEl: HTMLDivElement
  private readonly offlineEl: HTMLDivElement
  private dragging = false
  private dragMoved = false
  private suppressClick = false
  private dragPointerId = 0
  private dragStartX = 0
  private dragStartY = 0
  private dragStartTop = 0
  private dragStartRight = 0
  /** 最近一次快照（折叠根/current 变化时即时重渲染用）。 */
  private lastSnapshot: AgentBoardSnapshot | null = null
  /** 用户手动折叠的根（idle 根默认折叠，除非在 expandedRoots）。 */
  private readonly collapsedRoots = new Set<string>()
  /** 用户手动展开的根（覆盖 idle 默认折叠）。 */
  private readonly expandedRoots = new Set<string>()

  constructor(ctx: ClientContext, state: BoardState, actions: WidgetBoardActions) {
    this.ctx = ctx
    this.state = state
    this.actions = actions
    this.root = document.createElement('div')
    this.root.className = 'swd-widget'
    this.root.style.top = `${this.state.top}px`
    this.root.style.right = `${this.state.right}px`
    this.applyFontSize(this.state.fontSize)

    this.titleTextEl = document.createElement('span')
    this.titleTextEl.className = 'swd-title-left'
    this.titleTextEl.textContent = 'Agent 看板'

    const modeBtn = document.createElement('span')
    modeBtn.className = 'swd-mode-btn'
    modeBtn.textContent = '▦'
    modeBtn.title = '显示形态：悬浮窗 / 停靠右侧 / 并存 / 隐藏'
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.actions.openModeMenu(modeBtn, () => { /* 菜单自行管理关闭 */ })
    })

    const fontMinusBtn = document.createElement('span')
    fontMinusBtn.className = 'swd-font-btn'
    fontMinusBtn.textContent = '−'
    fontMinusBtn.title = '减小字号（当前 ' + this.state.fontSize + 'px）'
    fontMinusBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.actions.onFontChange(-1)
    })
    const fontPlusBtn = document.createElement('span')
    fontPlusBtn.className = 'swd-font-btn'
    fontPlusBtn.textContent = '+'
    fontPlusBtn.title = '增大字号（当前 ' + this.state.fontSize + 'px）'
    fontPlusBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.actions.onFontChange(1)
    })

    const closeBtn = document.createElement('span')
    closeBtn.className = 'swd-close'
    closeBtn.textContent = '×'
    closeBtn.title = '关闭悬浮窗（并存时保留停靠面板）'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.actions.onHide()
    })

    this.titleBarEl = document.createElement('div')
    this.titleBarEl.className = 'swd-title'
    this.titleBarEl.title = 'Agent 看板（拖动移动 · 点击折叠/展开）'
    this.titleBarEl.appendChild(this.titleTextEl)
    this.titleBarEl.appendChild(fontMinusBtn)
    this.titleBarEl.appendChild(fontPlusBtn)
    this.titleBarEl.appendChild(modeBtn)
    this.titleBarEl.appendChild(closeBtn)
    this.titleBarEl.addEventListener('pointerdown', (e) => this.beginDrag(e))
    this.titleBarEl.addEventListener('click', (e) => {
      if (e.target === closeBtn || e.target === modeBtn || e.target === fontMinusBtn || e.target === fontPlusBtn) return
      if (this.suppressClick) {
        this.suppressClick = false
        return
      }
      this.actions.onCollapsedChange(!this.state.collapsed)
    })

    this.treeEl = document.createElement('ul')
    this.treeEl.className = 'swd-tree'
    this.emptyEl = document.createElement('div')
    this.emptyEl.className = 'swd-empty'
    this.emptyEl.style.display = 'none'
    this.offlineEl = document.createElement('div')
    this.offlineEl.className = 'swd-offline'
    this.offlineEl.textContent = '离线（宿主路由不可达）'
    this.offlineEl.style.display = 'none'

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'swd-body'
    this.bodyEl.appendChild(this.offlineEl)
    this.bodyEl.appendChild(this.emptyEl)
    this.bodyEl.appendChild(this.treeEl)

    this.root.appendChild(this.titleBarEl)
    this.root.appendChild(this.bodyEl)
  }

  /** 构建完成（显隐由 App.sync() 按 mode 编排，这里不自行挂载）。 */
  mount(): void {
    this.renderCollapse()
  }

  show(): void {
    if (!this.root.isConnected) document.body.appendChild(this.root)
    this.renderCollapse()
    if (this.lastSnapshot !== null) this.render(this.lastSnapshot)
  }

  hide(): void {
    this.root.remove()
  }

  dispose(): void {
    this.root.remove()
  }

  /** App 在折叠状态变化后调用（标题点击切换）。 */
  renderCollapseNow(): void {
    this.renderCollapse()
  }

  private renderCollapse(): void {
    this.bodyEl.style.display = this.state.collapsed ? 'none' : 'block'
  }

  /** 应用字号（px，CSS 变量；辅助元素字号自动降 1px）。 */
  applyFontSize(size: number): void {
    this.root.style.setProperty('--ab-font', `${size}px`)
    this.root.style.setProperty('--ab-font-sub', `${Math.max(8, size - 1)}px`)
  }

  /** 离线提示（App 在传输失败时调用）。 */
  setOffline(offline: boolean): void {
    this.offlineEl.style.display = offline ? 'block' : 'none'
    this.treeEl.style.display = offline ? 'none' : 'block'
    this.emptyEl.style.display = 'none'
    if (offline) this.titleTextEl.textContent = 'Agent 看板（离线）'
  }

  /** 渲染最新快照（App 轮询/SSE/current 变化时调用）。 */
  render(snapshot: AgentBoardSnapshot): void {
    this.lastSnapshot = snapshot
    if (!this.root.isConnected) return
    this.setOffline(false)
    const currentId = this.ctx.sessions.list.getSnapshot().current
    renderBoardTree({
      treeEl: this.treeEl,
      emptyEl: this.emptyEl,
      titleEl: this.titleTextEl,
      snapshot,
      currentId,
      collapsedRoots: this.collapsedRoots,
      expandedRoots: this.expandedRoots,
      onOpen: (id, parentId) => this.actions.onOpen(id, parentId),
      afterToggle: () => {
        if (this.lastSnapshot !== null) this.render(this.lastSnapshot)
      },
    })
  }

  private beginDrag(e: PointerEvent): void {
    if (e.target instanceof Element && (e.target.classList.contains('swd-close') || e.target.classList.contains('swd-mode-btn') || e.target.classList.contains('swd-font-btn'))) return
    this.dragging = true
    this.dragMoved = false
    this.dragPointerId = e.pointerId
    this.dragStartX = e.clientX
    this.dragStartY = e.clientY
    this.dragStartTop = this.state.top
    this.dragStartRight = this.state.right
    try {
      this.titleBarEl.setPointerCapture(e.pointerId)
    } catch { /* capture is best-effort */ }
    window.addEventListener('pointermove', this.onDragMove)
    window.addEventListener('pointerup', this.onDragEnd, { once: true })
    window.addEventListener('pointercancel', this.onDragEnd, { once: true })
  }

  private readonly onDragMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return
    const dx = e.clientX - this.dragStartX
    const dy = e.clientY - this.dragStartY
    if (Math.abs(dx) + Math.abs(dy) > 4) this.dragMoved = true
    this.state.top = Math.max(0, this.dragStartTop + dy)
    this.state.right = Math.max(0, this.dragStartRight - dx)
    this.root.style.top = `${Math.round(this.state.top)}px`
    this.root.style.right = `${Math.round(this.state.right)}px`
  }

  private readonly onDragEnd = (): void => {
    if (!this.dragging) return
    this.dragging = false
    window.removeEventListener('pointermove', this.onDragMove)
    if (this.dragMoved) this.suppressClick = true
    saveState(this.state)
  }
}

/**
 * 看板管理器：状态事实源 + 双形态编排 + 轮询/SSE 数据流。
 * 悬浮窗与停靠面板都只是渲染容器，管理器统一喂数据。
 */
class AgentBoardApp {
  private readonly ctx: ClientContext
  private readonly state: BoardState
  private readonly widget: AgentBoardWidget
  private readonly docked: DockedAgentBoard
  private lastSnapshot: AgentBoardSnapshot | null = null
  private lastRenderedCurrent: string | undefined
  private timer: number | undefined
  private fetching = false
  private sseSource: EventSource | null = null
  private unsubscribeList: (() => void) | null = null
  private summonEl: HTMLButtonElement | null = null
  private visibilityCleanup: (() => void) | null = null
  private disposed = false

  constructor(ctx: ClientContext) {
    this.ctx = ctx
    this.state = loadState()

    const widgetActions: WidgetBoardActions = {
      onOpen: (id, parentId) => this.openSession(id, parentId),
      openModeMenu,
      onFontChange: (delta) => this.adjustFontSize(delta),
      onHide: () => {
        // × 只关闭悬浮窗：并存时切到停靠形态；单形态时才整体隐藏。
        if (this.state.mode === 'both') {
          this.state.mode = 'docked'
          saveState(this.state)
          this.sync()
        } else {
          this.applyVisibility(false)
        }
      },
      onCollapsedChange: (collapsed) => {
        this.state.collapsed = collapsed
        saveState(this.state)
        this.widget.renderCollapseNow()
      },
    }
    const dockedActions: DockedBoardActions = {
      onOpen: (id, parentId) => this.openSession(id, parentId),
      openModeMenu,
      onHide: () => {
        // × 只关闭停靠面板：并存时切到悬浮窗形态；单形态时才整体隐藏。
        if (this.state.mode === 'both') {
          this.state.mode = 'floating'
          saveState(this.state)
          this.sync()
        } else {
          this.applyVisibility(false)
        }
      },
      onCollapsedChange: (collapsed) => {
        this.state.dockedCollapsed = collapsed
        saveState(this.state)
        this.docked.syncLayout()
      },
      onWidthChange: (width) => {
        this.state.dockedWidth = width
      },
      onWidthCommit: () => saveState(this.state),
      onExpand: () => {
        this.state.dockedCollapsed = false
        saveState(this.state)
        this.docked.syncLayout()
      },
    }

    this.widget = new AgentBoardWidget(ctx, this.state, widgetActions)
    this.docked = new DockedAgentBoard(ctx, dockedActions)
    this.docked.bindState(this.state)

    // 事件总线（监听器绑定为类字段，dispose 时可移除）。
    document.addEventListener(TOGGLE_EVENT_NAME, this.onToggleEvent)
    document.addEventListener(MODE_EVENT, this.onModeEvent as EventListener)
  }

  mount(): void {
    ensureStyles()
    this.widget.mount()
    this.docked.mount()
    // 初始字号应用到双形态（悬浮窗构造时已应用，停靠面板在此补上）。
    this.docked.applyFontSize(this.state.fontSize)

    // 会话切换（current 变化）即时重渲染，「当前」标记不等轮询周期；
    // 只在 current 变化时重建（其他订阅通知不触发，减少主线程负担）。
    this.unsubscribeList = this.ctx.sessions.list.subscribe(() => {
      if (this.lastSnapshot === null) return
      const current = this.ctx.sessions.list.getSnapshot().current
      if (current !== this.lastRenderedCurrent) {
        this.lastRenderedCurrent = current
        this.render(this.lastSnapshot)
      }
    })

    this.sync()
    this.poll()

    // SSE：数据变化即时刷新（EventSource 自动重连；失败退化为轮询兜底）。
    this.sseSource = new EventSource('/api/agent-board/stream')
    this.sseSource.onmessage = () => this.poll()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.unsubscribeList?.()
    this.unsubscribeList = null
    this.sseSource?.close()
    this.sseSource = null
    this.widget.dispose()
    this.docked.dispose()
    this.removeSummon()
    document.removeEventListener(TOGGLE_EVENT_NAME, this.onToggleEvent)
    document.removeEventListener(MODE_EVENT, this.onModeEvent as EventListener)
  }

  private readonly onToggleEvent = (): void => {
    this.applyVisibility(!this.state.visible)
  }

  private readonly onModeEvent = ((e: CustomEvent<{ mode?: BoardMode; visible?: boolean }>) => {
    const detail = e.detail
    if (detail.mode !== undefined) this.state.mode = detail.mode
    if (detail.visible !== undefined) this.state.visible = detail.visible
    // 切到可见形态即展开（清折叠态），避免「开了面板只剩一条线」。
    if (this.state.visible) {
      if (this.state.dockedCollapsed) {
        this.state.dockedCollapsed = false
        this.docked.syncLayout()
      }
      if (this.state.collapsed) {
        this.state.collapsed = false
        this.widget.renderCollapseNow()
      }
    }
    saveState(this.state)
    this.sync()
  }) as EventListener

  /** 字号步进调节（−/+）：夹取范围 → 落盘 → 应用到悬浮窗与停靠面板。 */
  private adjustFontSize(delta: number): void {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, this.state.fontSize + delta))
    if (next === this.state.fontSize) return
    this.state.fontSize = next
    saveState(this.state)
    this.widget.applyFontSize(next)
    this.docked.applyFontSize(next)
  }

  /** 设置总开关并同步双形态。打开时自动展开（清折叠态）——
   *  用户点「Agent 看板」期望看到内容，不留「只剩一条线」的折叠残留。 */
  private applyVisibility(visible: boolean): void {
    this.state.visible = visible
    if (visible) {
      if (this.state.dockedCollapsed) {
        this.state.dockedCollapsed = false
        this.docked.syncLayout()
      }
      if (this.state.collapsed) {
        this.state.collapsed = false
        this.widget.renderCollapseNow()
      }
    }
    saveState(this.state)
    this.sync()
  }

  /** 按 mode/visible 编排双形态的显隐。 */
  private sync(): void {
    const showFloating = this.state.visible && (this.state.mode === 'floating' || this.state.mode === 'both')
    const showDocked = this.state.visible && (this.state.mode === 'docked' || this.state.mode === 'both')
    if (showFloating) this.widget.show()
    else this.widget.hide()
    if (showDocked) this.docked.show()
    else this.docked.hide()
    this.renderSummon()
    if (this.state.visible) this.start()
    else this.stop()
    if (this.lastSnapshot !== null) this.render(this.lastSnapshot)
  }

  private renderSummon(): void {
    if (this.state.visible) {
      this.removeSummon()
      return
    }
    if (this.summonEl !== null) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'swd-summon'
    btn.textContent = '◉ Agent 看板'
    btn.addEventListener('click', () => this.applyVisibility(true))
    document.body.appendChild(btn)
    this.summonEl = btn
  }

  private removeSummon(): void {
    this.summonEl?.remove()
    this.summonEl = null
  }

  /** 点击节点跳转会话。打开 = 已查看：完成节点标记已读（蓝→灰/空闲）。 */
  private openSession(id: string, parentId?: string): Promise<boolean> {
    markViewed(id)
    return openBoardSession(this.ctx, id, parentId)
  }

  private start(): void {
    if (this.timer !== undefined) return
    this.timer = window.setInterval(() => this.poll(), POLL_MS)
    this.visibilityCleanup = this.watchVisibility()
  }

  private stop(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }
    this.visibilityCleanup?.()
    this.visibilityCleanup = null
  }

  /** 标签页隐藏时暂停轮询（后台标签零请求）。 */
  private watchVisibility(): () => void {
    const onVisibility = (): void => {
      if (document.hidden) this.stop()
      else this.start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }

  private poll(): void {
    if (this.fetching || document.hidden || this.disposed) return
    if (!this.state.visible) return
    this.fetching = true
    void fetch('/api/agent-board/agents')
      .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.json() as Promise<AgentBoardSnapshot> })
      .then(snapshot => {
        this.lastSnapshot = snapshot
        this.render(snapshot)
      })
      .catch(() => {
        this.widget.setOffline(true)
        this.docked.setOffline(true)
      })
      .finally(() => { this.fetching = false })
  }

  private render(snapshot: AgentBoardSnapshot): void {
    this.widget.render(snapshot)
    this.docked.render(snapshot)
  }
}

/** 侧边栏 foot 触发器（rail 时仅图标，wide 时图标 + 文字）。 */
function AgentBoardAction(props: { wide: boolean }) {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const onToggle = (): void => setActive(v => !v)
    document.addEventListener(TOGGLE_EVENT_NAME, onToggle)
    return () => document.removeEventListener(TOGGLE_EVENT_NAME, onToggle)
  }, [])
  return (
    <button
      className="swd-action"
      title="Agent 看板"
      style={active ? { color: '#9ad0ff' } : undefined}
      onClick={() => emitToggle()}
    >
      <span>◉</span>
      {props.wide && <span>Agent 看板</span>}
    </button>
  )
}

/** 设置 → 常规 → 「Agent 看板」形态选择行（localStorage 直读写 + 事件广播）。 */
function AgentBoardSettingRow() {
  const [mode, setMode] = useState<BoardMode | 'hidden'>(() => currentModeValue(loadState()))
  useEffect(() => {
    const sync = (): void => setMode(currentModeValue(loadState()))
    document.addEventListener(TOGGLE_EVENT_NAME, sync)
    document.addEventListener(MODE_EVENT, sync)
    return () => {
      document.removeEventListener(TOGGLE_EVENT_NAME, sync)
      document.removeEventListener(MODE_EVENT, sync)
    }
  }, [])
  const onChange = (value: BoardMode | 'hidden'): void => {
    const state = loadState()
    if (value === 'hidden') {
      state.visible = false
    } else {
      state.mode = value
      state.visible = true
    }
    saveState(state)
    emitModeChange(state.mode, state.visible)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
      <span style={{ color: 'inherit', fontSize: 'inherit' }}>Agent 看板</span>
      <select
        value={mode}
        onChange={e => onChange(e.target.value as BoardMode | 'hidden')}
        style={{ color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 4, padding: '2px 6px', fontSize: 'inherit' }}
      >
        <option value="floating">{MODE_LABELS.floating}</option>
        <option value="docked">{MODE_LABELS.docked}</option>
        <option value="both">{MODE_LABELS.both}</option>
        <option value="hidden">{MODE_LABELS.hidden}</option>
      </select>
    </div>
  )
}

/**
 * Client plugin body: mount the board app (floating widget + docked panel),
 * register the sidebar footer action and the settings row.
 * @param ctx - client root context (slots + cordis base).
 */
export const inject = ['slots', 'sessions'] as const

export function apply(ctx: ClientContext): void {
  loadViewed()
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-agent-board',
    order: 100,
    inject: () => ({}),
  }, AgentBoardAction), 'agent-board: footer action')
  ctx.effect(() => ctx.slots.register({
    name: 'settings.general.item',
    id: 'agent-board',
    order: 30,
    inject: () => ({}),
  }, AgentBoardSettingRow), 'agent-board: settings row')
  ctx.effect(() => {
    const app = new AgentBoardApp(ctx)
    app.mount()
    return () => app.dispose()
  }, 'agent-board: app')
}
