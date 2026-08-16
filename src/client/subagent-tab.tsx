/**
 * 会话页「子代理」tab：左主右子分屏视图。
 *
 * 布局：左侧 = 当前主 agent 会话的完整对话流（文本消息，只读）；右侧 =
 * 该会话的直属子代理（parentSession === sessionId 且 depth === 1）窗格列表，
 * 各窗格均分高度、整体可滚动；中间一条可拖拽分隔条（左宽右窄，宽度持久化
 * localStorage `dsh.agentBoard.tabSplit.v1`，向右拖 = 左变宽）。
 *
 * 数据流：挂载即拉 `GET /api/agent-board/agents` + 2s 轮询 + SSE
 * `GET /api/agent-board/stream` 即时刷新（卸载清理）；「当前会话」取
 * conversation.view 槽位注入的 sessionId（本 tab 属于具体会话页，不随
 * current 变化）。
 *
 * 筛选复用 tree.ts 规则：finished 超 30 分钟剔除（keepRow）、每会话最多
 * 12 条 finished（快照序 = 创建时间新→旧）；running 恒显示；waiting
 * （等待人工）整卡黄色高亮。
 *
 * 对话渲染：主会话/子代理会话统一走「binding（ctx.sessions.binding →
 * snapshot.nodes 文本消息，可订阅实时更新）→ 降级 host RPC
 * POST /api/session.history（result.value.events 的 user/assistant/message
 * 文本）→ 兜底 lastReply 节选」链路。
 *
 * 交互：单击窗格 = 展开聚焦（占满右侧，完整信息 + 对话区）；再点或点
 * 「收起」返回分屏均分；窗格内「对话」按钮 = 监控卡 ↔ 子代理对话流切换；
 * 「跳转」按钮 = openBoardSession（复用 tree.ts，含已读标记）。
 *
 * 全部渲染为 plain DOM（与悬浮窗/停靠面板同风格），仅入口是薄 React 壳
 * （conversation.view 槽位组件必须是 React 组件）。
 *
 * Failure policy: transport errors render an "offline" hint and keep the
 * poll alive; nothing throws (the web shell fails boot on apply throw).
 * @module @dsh-external/dsh-agent-board/client/subagent-tab
 */

import type {
  ClientContext, ConversationNode, PendingInteraction, SessionFace, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register call to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import type { AgentBoardSnapshot, AgentSnapshotRow } from '../index.js'
import { en, NS, zh } from './locales.js'
import {
  formatDuration,
  isViewed,
  keepRow,
  markViewed,
  newRpcId,
  openBoardSession,
  statusText,
} from './tree.js'

/** Poll interval (ms) while the tab is mounted and the page visible. */
const POLL_MS = 2000

/** 分隔条位置持久化 key（左栏宽度 px）。 */
const SPLIT_KEY = 'dsh.agentBoard.tabSplit.v1'
/** 左栏最小宽度（px）。 */
const SPLIT_MIN_PX = 240
/** 左栏最大宽度 = 容器宽度比例（规格：最大视口 60%）。 */
const SPLIT_MAX_RATIO = 0.6
/** 无持久化值时的默认左栏占比。 */
const SPLIT_DEFAULT_RATIO = 0.45
/** 直属子代理里最多保留的 finished 卡数（running 不限）——照 tree.ts MAX_FINISHED_PER_ROOT。 */
const MAX_FINISHED_CARDS = 12
/** id 展示前缀长度。 */
const ID_PREFIX = 8
/** 拖拽超过该位移视为拖动而非点击（滚动/点选区分）。 */
const CLICK_MOVE_PX = 4

/** 一条纯文本对话消息（自绘轻量对话用）。 */
interface TextMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
}

/** 一次会话对话的加载结果。 */
interface ConversationData {
  readonly state: 'loading' | 'ok' | 'fail'
  readonly messages: readonly TextMessage[]
  /** 加载失败时的兜底节选（lastReply）。 */
  readonly fallback: string | null
}

/** session.history 事件的最小结构面（与 host SessionEventLike 一致）。 */
interface RpcHistoryEvent {
  readonly type?: string
  readonly seq?: number
  readonly time?: number
  readonly data?: {
    readonly message?: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }
  }
}

/** question/requested 帧载荷（AskUserQuestionItem）的最小结构面。 */
interface QuestionItemLike {
  readonly id?: string
  readonly question?: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label?: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** 一张子代理窗格的 DOM 引用。 */
interface CardEl {
  readonly id: string
  readonly root: HTMLDivElement
  readonly dotEl: HTMLSpanElement
  readonly titleEl: HTMLSpanElement
  readonly idEl: HTMLSpanElement
  readonly statusEl: HTMLSpanElement
  readonly silentEl: HTMLSpanElement
  readonly actionEl: HTMLSpanElement
  readonly replyEl: HTMLSpanElement
  readonly waitingEl: HTMLSpanElement
  readonly convBtnEl: HTMLButtonElement
  readonly openBtnEl: HTMLButtonElement
  readonly collapseBtnEl: HTMLButtonElement
  readonly bodyEl: HTMLDivElement
  readonly detailsEl: HTMLDivElement
  readonly convEl: HTMLDivElement
  readonly convListEl: HTMLDivElement
}

/** 全部样式（子代理 tab），一次性注入 <head>。前缀 swt- 与看板 swd-* 隔离。 */
const TAB_CSS = `
.swt-root {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.swt-left {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
}
.swt-left-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  font-weight: 600;
  color: var(--dsw-alias-brand-primary, #9ad0ff);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  white-space: nowrap;
}
.swt-left-head-id { color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 10px; font-weight: 400; }
.swt-left-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px;
}
.swt-msg { margin-bottom: 10px; }
.swt-msg-user { display: flex; flex-direction: column; align-items: flex-end; }
.swt-msg-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa0a6); margin-bottom: 3px; }
.swt-msg-user .swt-msg-label { text-align: right; }
/* 用户消息：右对齐气泡（照对话页 bubble 观感：大圆角、主题底色、有宽度上限） */
.swt-bubble {
  max-width: min(525px, 86%);
  background: var(--dsw-specific-bubble, rgba(37, 99, 235, 0.16));
  border-radius: 18px;
  padding: 8px 14px;
  font-size: 14px;
  line-height: 1.65;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 助手消息：整行 markdown 排版（无气泡壳） */
.swt-md { font-size: 14px; line-height: 1.7; color: var(--dsw-alias-label-primary, #e6e6e6); }
.swt-md p { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
.swt-md p:last-child { margin-bottom: 0; }
.swt-md h1, .swt-md h2, .swt-md h3, .swt-md h4 { margin: 10px 0 6px; font-weight: 700; line-height: 1.4; }
.swt-md h1 { font-size: 18px; }
.swt-md h2 { font-size: 16px; }
.swt-md h3 { font-size: 15px; }
.swt-md h4 { font-size: 14px; }
.swt-md pre {
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 8px 10px;
  overflow-x: auto;
  margin: 6px 0;
}
.swt-md pre code {
  background: none;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  white-space: pre;
}
.swt-md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));
  padding: 1px 4px;
  border-radius: 4px;
}
.swt-md strong { font-weight: 700; }
.swt-md em { font-style: italic; }
.swt-md blockquote {
  margin: 6px 0;
  padding: 2px 10px;
  border-left: 3px solid var(--dsw-alias-border-l2, rgba(154, 208, 255, 0.4));
  color: var(--dsw-alias-label-secondary, #9aa0a6);
}
.swt-md ul, .swt-md ol { margin: 4px 0 8px; padding-left: 22px; }
.swt-md li { margin: 2px 0; }
.swt-md a { color: var(--dsw-alias-brand-primary, #9ad0ff); text-decoration: underline; }
.swt-md hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12)); margin: 8px 0; }
.swt-md del { text-decoration: line-through; }
/* 底部交互区：等待人工的提问/审批卡片（照对话页 composer 占位位置） */
.swt-left-interact {
  flex: none;
  max-height: 45%;
  overflow-y: auto;
  display: none;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03));
}
.swt-qcard, .swt-acard {
  border: 1px solid #fbbf24;
  border-radius: 10px;
  background: rgba(251, 191, 36, 0.08);
  padding: 8px 10px;
}
.swt-qcard-head, .swt-acard-head { font-weight: 700; color: #fbbf24; margin-bottom: 4px; }
.swt-qcard-q { font-weight: 600; margin: 4px 0 2px; word-break: break-word; }
.swt-qcard-detail { color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 12px; white-space: pre-wrap; word-break: break-word; margin-bottom: 4px; }
.swt-qcard-option {
  display: block;
  width: 100%;
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14));
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04));
  color: var(--dsw-alias-label-primary, #e6e6e6);
  border-radius: 6px;
  padding: 4px 8px;
  margin: 3px 0;
  font: inherit;
  font-size: 13px;
}
.swt-qcard-option:hover { border-color: var(--dsw-alias-brand-primary, #9ad0ff); }
.swt-qcard-option.selected { border-color: #fbbf24; background: rgba(251, 191, 36, 0.15); }
.swt-qcard-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14));
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04));
  color: var(--dsw-alias-label-primary, #e6e6e6);
  border-radius: 6px;
  padding: 4px 8px;
  font: inherit;
  font-size: 13px;
  margin-top: 4px;
}
.swt-qcard-actions, .swt-acard-actions { display: flex; gap: 8px; margin-top: 6px; justify-content: flex-end; }
.swt-qcard-btn, .swt-acard-btn {
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.05));
  color: var(--dsw-alias-label-primary, #e6e6e6);
  border-radius: 6px;
  padding: 3px 12px;
  font: inherit;
  font-size: 13px;
}
.swt-qcard-btn:hover, .swt-acard-btn:hover { border-color: var(--dsw-alias-brand-primary, #9ad0ff); }
.swt-qcard-btn:disabled, .swt-acard-btn:disabled { opacity: 0.5; cursor: default; }
.swt-qcard-primary, .swt-acard-primary { border-color: #fbbf24; color: #fbbf24; font-weight: 600; }
.swt-qcard-primary:hover, .swt-acard-primary:hover { background: rgba(251, 191, 36, 0.15); }
.swt-qcard-err, .swt-acard-err { color: #f87171; font-size: 12px; margin-top: 4px; word-break: break-word; }
.swt-acard-headline { white-space: pre-wrap; word-break: break-word; }
.swt-divider {
  flex: none;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
  position: relative;
  background: transparent;
}
.swt-divider::after {
  content: '';
  position: absolute;
  left: 2.5px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--dsw-alias-border-l2, rgba(154, 208, 255, 0.35));
}
.swt-divider:hover::after, .swt-divider.swt-dragging::after {
  background: var(--dsw-alias-brand-primary, rgba(154, 208, 255, 0.75));
}
.swt-right {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.swt-right-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  font-weight: 600;
  color: var(--dsw-alias-brand-primary, #9ad0ff);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  white-space: nowrap;
}
.swt-right-head-hint { color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 10px; font-weight: 400; }
.swt-cards {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px;
}
.swt-card {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03));
  overflow: hidden;
  cursor: pointer;
}
.swt-card:hover { border-color: var(--dsw-alias-border-l2, rgba(154, 208, 255, 0.4)); }
.swt-card.swt-opening { border-color: rgba(154, 208, 255, 0.65); }
.swt-card.swt-open-failed { border-color: rgba(248, 113, 113, 0.75); }
.swt-card.swt-expanded { flex: 1 1 auto; }
.swt-card.swt-hidden { display: none; }
.swt-card.swt-finished { opacity: 0.78; }
.swt-card.swt-waiting {
  border-color: #fbbf24;
  background: rgba(251, 191, 36, 0.09);
}
.swt-card-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
  white-space: nowrap;
}
.swt-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.swt-st-running { background: #4ade80; }
.swt-st-idle { background: #6b7280; }
.swt-st-stall { background: #f87171; }
.swt-st-finished { background: #60a5fa; }
.swt-st-waiting { background: #fbbf24; }
.swt-card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.swt-card-id { flex: none; color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 10px; }
.swt-card-btn {
  flex: none;
  cursor: pointer;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  font: inherit;
  font-size: 11px;
  line-height: 1.5;
  padding: 0 5px;
  border-radius: 4px;
  white-space: nowrap;
}
.swt-card-btn:hover { color: var(--dsw-alias-label-primary, #fff); background: rgba(255, 255, 255, 0.07); }
.swt-card-btn.swt-btn-primary { color: var(--dsw-alias-brand-primary, #9ad0ff); }
.swt-card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.swt-details { flex: none; padding: 4px 8px; min-height: 0; overflow: auto; }
.swt-detail-row { display: flex; gap: 6px; align-items: baseline; padding: 1px 0; }
.swt-detail-label { flex: none; color: var(--dsw-alias-label-secondary, #9aa0a6); }
.swt-detail-val { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swt-card.swt-expanded .swt-detail-val { white-space: pre-wrap; word-break: break-word; }
.swt-detail-val.swt-stall { color: #f87171; font-weight: 700; }
.swt-detail-val.swt-waiting-val { color: #fbbf24; }
.swt-detail-val.swt-reply { color: var(--dsw-alias-label-secondary, #8b93a1); }
.swt-conv {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
}
.swt-conv-head {
  flex: none;
  padding: 2px 8px;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.06));
}
.swt-conv-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px; }
.swt-hint {
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  text-align: center;
  padding: 10px 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.swt-offline { color: #fbbf24; text-align: center; padding: 10px 8px; }
.swt-empty { color: var(--dsw-alias-label-secondary, #9aa0a6); text-align: center; padding: 16px 8px; }
/* ===== 浅色主题（令牌缺失时按系统明暗回退） ===== */
@media (prefers-color-scheme: light) {
  .swt-root { color: var(--dsw-alias-label-primary, #1f2937); }
  .swt-left { border-right-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12)); }
  .swt-left-head { color: var(--dsw-alias-brand-primary, #2563eb); }
  .swt-left-head-id { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-msg-label { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-bubble { border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1)); background: var(--dsw-specific-bubble, rgba(37, 99, 235, 0.08)); }
  .swt-md { color: var(--dsw-alias-label-primary, #1f2937); }
  .swt-md pre { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04)); border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1)); }
  .swt-md code { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06)); }
  .swt-md blockquote { border-left-color: var(--dsw-alias-border-l2, rgba(37, 99, 235, 0.35)); color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-md a { color: var(--dsw-alias-brand-primary, #2563eb); }
  .swt-left-interact { border-top-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1)); background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.7)); }
  .swt-qcard, .swt-acard { border-color: #d97706; background: rgba(217, 119, 6, 0.08); }
  .swt-qcard-head, .swt-acard-head { color: #b45309; }
  .swt-qcard-detail { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-qcard-option { border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.14)); background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03)); color: var(--dsw-alias-label-primary, #1f2937); }
  .swt-qcard-option:hover { border-color: var(--dsw-alias-brand-primary, #2563eb); }
  .swt-qcard-option.selected { border-color: #d97706; background: rgba(217, 119, 6, 0.12); }
  .swt-qcard-input { border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.14)); background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03)); color: var(--dsw-alias-label-primary, #1f2937); }
  .swt-qcard-btn, .swt-acard-btn { border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16)); background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03)); color: var(--dsw-alias-label-primary, #1f2937); }
  .swt-qcard-btn:hover, .swt-acard-btn:hover { border-color: var(--dsw-alias-brand-primary, #2563eb); }
  .swt-qcard-primary, .swt-acard-primary { border-color: #d97706; color: #b45309; }
  .swt-qcard-primary:hover, .swt-acard-primary:hover { background: rgba(217, 119, 6, 0.1); }
  .swt-qcard-err, .swt-acard-err { color: #dc2626; }
  .swt-divider::after { background: var(--dsw-alias-border-l2, rgba(37, 99, 235, 0.3)); }
  .swt-divider:hover::after, .swt-divider.swt-dragging::after { background: var(--dsw-alias-brand-primary, rgba(37, 99, 235, 0.65)); }
  .swt-right-head { color: var(--dsw-alias-brand-primary, #2563eb); }
  .swt-right-head-hint { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-card { border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12)); background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.7)); }
  .swt-card:hover { border-color: var(--dsw-alias-border-l2, rgba(37, 99, 235, 0.4)); }
  .swt-card.swt-waiting { border-color: #d97706; background: rgba(217, 119, 6, 0.08); }
  .swt-st-running { background: #16a34a; }
  .swt-st-idle { background: #6b7280; }
  .swt-st-stall { background: #dc2626; }
  .swt-st-finished { background: #2563eb; }
  .swt-st-waiting { background: #d97706; }
  .swt-card-id { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-card-btn { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-card-btn:hover { color: var(--dsw-alias-label-primary, #111827); background: rgba(0, 0, 0, 0.05); }
  .swt-card-btn.swt-btn-primary { color: var(--dsw-alias-brand-primary, #2563eb); }
  .swt-detail-label { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-detail-val.swt-stall { color: #dc2626; }
  .swt-detail-val.swt-waiting-val { color: #b45309; }
  .swt-detail-val.swt-reply { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-conv-head { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-hint { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-offline { color: #b45309; }
  .swt-empty { color: var(--dsw-alias-label-secondary, #6b7280); }
}
`

let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = TAB_CSS
  document.head.appendChild(style)
}

/** 从 content blocks（user 消息 / RPC 事件）里提取文本块。 */
function textFromContent(
  content: readonly { readonly type?: string; readonly text?: string }[] | undefined,
): string {
  if (content === undefined) return ''
  return content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => (b.text as string))
    .join('\n')
    .trim()
}

/** 从会话快照 nodes（binding 路径）里收集 user/assistant 文本消息。 */
function collectMessages(nodes: readonly ConversationNode[]): TextMessage[] {
  const out: TextMessage[] = []
  for (const node of nodes) {
    if (node.kind === 'user' || node.kind === 'steering') {
      const text = textFromContent(node.content)
      if (text !== '') out.push({ role: 'user', text, time: node.time })
    } else if (node.kind === 'assistant') {
      const text = node.blocks
        .filter(b => b.kind === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
      if (text !== '') out.push({ role: 'assistant', text, time: node.time })
    }
  }
  return out
}

/** host RPC session.history：拿不到 binding 时的降级文本消息来源。 */
async function fetchSessionHistory(sessionId: string): Promise<TextMessage[] | null> {
  try {
    const res = await fetch('/api/session.history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: newRpcId(),
        method: 'session.history',
        payload: { sessionId },
      }),
    })
    if (!res.ok) return null
    const full = await res.json() as {
      result?: { ok?: boolean; value?: { events?: readonly { event?: RpcHistoryEvent }[] } }
    }
    const events = full.result?.ok === true ? full.result.value?.events ?? [] : []
    const out: TextMessage[] = []
    for (const entry of events) {
      const ev = entry.event
      if (ev === undefined) continue
      const m = /^(user|assistant|steering)\/message$/u.exec(ev.type ?? '')
      if (m === null) continue
      const text = textFromContent(ev.data?.message?.content)
      if (text === '') continue
      out.push({
        role: m[1] === 'assistant' ? 'assistant' : 'user',
        text,
        time: ev.time ?? 0,
      })
    }
    return out
  } catch {
    return null
  }
}

/** HTML 转义（markdown 渲染的注入安全基础：先转义再变换）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 链接白名单：仅 http(s)/mailto/相对路径，防止 javascript: 注入。 */
const SAFE_URL = /^(https?:|mailto:|\/|#|\.)/i

/** 行内 markdown：行内代码（先占位保护）→ 加粗 → 斜体 → 删除线 → 链接。 */
function inlineMarkdown(escaped: string): string {
  const codes: string[] = []
  let out = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(code)
    return `\u0001${codes.length - 1}\u0001`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    if (!SAFE_URL.test(url)) return m
    return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`
  })
  out = out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ''}</code>`)
  return out
}

/** 轻量 markdown → DOM（自绘对话流用；块级：代码围栏/标题/引用/列表/分隔线/段落）。 */
function renderMarkdown(text: string): HTMLDivElement {
  const root = document.createElement('div')
  root.className = 'swt-md'
  const lines = text.split('\n')
  let para: string[] = []
  let inCode = false
  let codeBuf: string[] = []
  let listKind: 'ul' | 'ol' | null = null
  let listEl: HTMLUListElement | HTMLOListElement | null = null
  const closeList = (): void => { listKind = null; listEl = null }
  const flushPara = (): void => {
    closeList()
    if (para.length === 0) return
    const p = document.createElement('p')
    p.innerHTML = inlineMarkdown(para.join('\n'))
    root.appendChild(p)
    para = []
  }
  const openList = (kind: 'ul' | 'ol'): void => {
    listKind = kind
    listEl = document.createElement(kind === 'ul' ? 'ul' : 'ol')
    root.appendChild(listEl)
  }
  const addItem = (kind: 'ul' | 'ol', content: string): void => {
    if (listKind !== kind || listEl === null) openList(kind)
    const li = document.createElement('li')
    li.innerHTML = inlineMarkdown(content)
    listEl!.appendChild(li)
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '')
    const fence = /^```(.*)$/u.exec(line)
    if (fence !== null) {
      if (inCode) {
        // 闭合围栏。
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        code.textContent = codeBuf.join('\n')
        pre.appendChild(code)
        root.appendChild(pre)
        inCode = false
        codeBuf = []
      } else {
        flushPara()
        inCode = true
        codeBuf = []
      }
      continue
    }
    if (inCode) {
      codeBuf.push(raw)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      flushPara()
      const hd = document.createElement(`h${heading[1]!.length}` as 'h1')
      hd.innerHTML = inlineMarkdown(heading[2]!)
      root.appendChild(hd)
      continue
    }
    const quote = /^>\s?(.*)$/u.exec(line)
    if (quote !== null) {
      flushPara()
      const bq = document.createElement('blockquote')
      bq.innerHTML = inlineMarkdown(quote[1]!)
      root.appendChild(bq)
      continue
    }
    const ul = /^\s*[-*]\s+(.*)$/u.exec(line)
    if (ul !== null) {
      addItem('ul', ul[1]!)
      continue
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/u.exec(line)
    if (ol !== null) {
      addItem('ol', ol[1]!)
      continue
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/u.test(line)) {
      flushPara()
      root.appendChild(document.createElement('hr'))
      continue
    }
    if (line.trim() === '') {
      flushPara()
      continue
    }
    closeList()
    para.push(line)
  }
  if (inCode) {
    // 未闭合围栏：按代码块收尾。
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = codeBuf.join('\n')
    pre.appendChild(code)
    root.appendChild(pre)
  } else {
    flushPara()
  }
  return root
}

/** 一条对话消息（照对话页观感：用户右对齐气泡，助手整行 markdown）。 */
function renderMessage(msg: TextMessage): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.className = `swt-msg swt-msg-${msg.role}`
  const label = document.createElement('div')
  label.className = 'swt-msg-label'
  const time = msg.time > 0 ? new Date(msg.time).toLocaleTimeString() : ''
  label.textContent = msg.role === 'user' ? `你 · ${time}` : `助手 · ${time}`
  wrap.appendChild(label)
  if (msg.role === 'user') {
    const bubble = document.createElement('div')
    bubble.className = 'swt-bubble'
    bubble.textContent = msg.text
    wrap.appendChild(bubble)
  } else {
    wrap.appendChild(renderMarkdown(msg.text))
  }
  return wrap
}

/** 一行居中提示。 */
function hintLine(text: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'swt-hint'
  el.textContent = text
  return el
}

/**
 * 会话页「子代理」tab 注册：locale 字典 + conversation.view 槽位条目
 * （order 20，与「对话」「轨迹」同级）。
 * @param ctx - client root context（slots + sessions + locale）。
 */
export function registerSubagentTab(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-board: locale dicts')
  // 注册期标签（tab 名）走绑定翻译 thunk，跟随当前语言。
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'subagent-board',
    order: 20,
    locale: NS,
    label: () => t('view.subagents'),
    inject: (sessionId: SessionId): SubagentTabInjected => ({ sessionId, ctx }),
  }, SubagentTabView))
}

/** conversation.view 注入面：本 tab 属于具体会话页，sessionId 固定。 */
export interface SubagentTabInjected {
  readonly sessionId: SessionId
  readonly ctx: ClientContext
}

/**
 * React 薄壳：挂载/卸载纯 DOM 控制器。数据、渲染、拖拽全在
 * SubagentTabController（plain DOM 风格，与看板双形态一致）。
 */
export function SubagentTabView(
  props: ConvViewProps & InjectFace<SubagentTabInjected> & PropsLocale<typeof NS>,
): ReactElement {
  const { sessionId, ctx } = props
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const controller = new SubagentTabController(ctx, sessionId, el)
    controller.mount()
    return () => controller.dispose()
  }, [ctx, sessionId])
  return <div ref={ref} className="swt-root" />
}

/** 子代理分屏视图控制器：布局 + 拖拽 + 轮询/SSE + 渲染。 */
class SubagentTabController {
  private readonly ctx: ClientContext
  private readonly sessionId: SessionId
  private readonly root: HTMLDivElement
  private readonly leftHeadIdEl: HTMLSpanElement
  private readonly leftBodyEl: HTMLDivElement
  private readonly interactEl: HTMLDivElement
  private readonly rightHeadCountEl: HTMLSpanElement
  private readonly cardsEl: HTMLDivElement
  private readonly offlineEl: HTMLDivElement
  private readonly emptyEl: HTMLDivElement
  private readonly dividerEl: HTMLDivElement

  /** id → 卡片 DOM。 */
  private readonly cards = new Map<string, CardEl>()
  /** 卡片 id → 对话模式开启（监控卡 ↔ 对话流）。 */
  private readonly convOn = new Set<string>()
  /** 卡片 id → 对话加载结果缓存。 */
  private readonly convData = new Map<string, ConversationData>()
  /** 卡片 id → 会话 binding 订阅（dispose 时统一退订）。 */
  private readonly convUnsubs = new Map<string, () => void>()
  /** 主会话 binding 订阅。 */
  private leftUnsub: (() => void) | null = null

  private snapshot: AgentBoardSnapshot | null = null
  /** 当前聚焦展开的卡片 id（null = 分屏均分）。 */
  private expandedId: string | null = null
  /** 左栏宽度（px）。 */
  private leftWidth = 0
  /** 左栏是否粘底（有新消息自动滚到底）。 */
  private leftStickBottom = true
  /** 提问卡选项选中态：`${wait.key}:${questionId}` → 已选 label 集合。 */
  private readonly questionSel = new Map<string, Set<string>>()
  /** 无选项提问的自由文本输入：`${wait.key}:${questionId}` → input。 */
  private readonly questionInputs = new Map<string, HTMLInputElement>()

  private timer: number | undefined
  private fetching = false
  private sse: EventSource | null = null
  private disposed = false
  private visibilityCleanup: (() => void) | null = null

  // 分隔条拖拽状态（rAF 节流 + pointer capture，照 docked.ts 风格）。
  private dragging = false
  private dragPointerId = 0
  private dragStartX = 0
  private dragStartWidth = 0
  private dragLatestWidth = 0
  private dragRaf: number | null = null
  private dragContainerWidth = 0

  constructor(ctx: ClientContext, sessionId: SessionId, root: HTMLDivElement) {
    this.ctx = ctx
    this.sessionId = sessionId
    this.root = root
    root.replaceChildren()

    const left = document.createElement('div')
    left.className = 'swt-left'
    const leftHead = document.createElement('div')
    leftHead.className = 'swt-left-head'
    const leftTitle = document.createElement('span')
    leftTitle.textContent = '主对话'
    this.leftHeadIdEl = document.createElement('span')
    this.leftHeadIdEl.className = 'swt-left-head-id'
    this.leftHeadIdEl.textContent = sessionId.slice(0, ID_PREFIX)
    leftHead.appendChild(leftTitle)
    leftHead.appendChild(this.leftHeadIdEl)
    this.leftBodyEl = document.createElement('div')
    this.leftBodyEl.className = 'swt-left-body'
    this.interactEl = document.createElement('div')
    this.interactEl.className = 'swt-left-interact'
    left.appendChild(leftHead)
    left.appendChild(this.leftBodyEl)
    left.appendChild(this.interactEl)

    this.dividerEl = document.createElement('div')
    this.dividerEl.className = 'swt-divider'
    this.dividerEl.title = '拖拽调整左右比例'
    this.dividerEl.addEventListener('pointerdown', (e) => this.beginDrag(e))

    const right = document.createElement('div')
    right.className = 'swt-right'
    const rightHead = document.createElement('div')
    rightHead.className = 'swt-right-head'
    const rightTitle = document.createElement('span')
    rightTitle.textContent = '子代理'
    this.rightHeadCountEl = document.createElement('span')
    this.rightHeadCountEl.className = 'swt-right-head-hint'
    const rightHint = document.createElement('span')
    rightHint.className = 'swt-right-head-hint'
    rightHint.textContent = '直属子代理（点击卡片展开聚焦）'
    rightHead.appendChild(rightTitle)
    rightHead.appendChild(this.rightHeadCountEl)
    rightHead.appendChild(rightHint)
    this.cardsEl = document.createElement('div')
    this.cardsEl.className = 'swt-cards'
    this.emptyEl = document.createElement('div')
    this.emptyEl.className = 'swt-empty'
    this.emptyEl.textContent = '暂无子代理'
    this.emptyEl.style.display = 'none'
    this.offlineEl = document.createElement('div')
    this.offlineEl.className = 'swt-offline'
    this.offlineEl.textContent = '离线（宿主路由不可达）'
    this.offlineEl.style.display = 'none'
    right.appendChild(rightHead)
    right.appendChild(this.offlineEl)
    right.appendChild(this.emptyEl)
    right.appendChild(this.cardsEl)

    root.appendChild(left)
    root.appendChild(this.dividerEl)
    root.appendChild(right)
  }

  mount(): void {
    ensureStyles()
    this.restoreSplit()
    this.loadLeftConversation()
    this.poll()
    this.timer = window.setInterval(() => this.poll(), POLL_MS)
    // SSE：数据变化即时刷新（EventSource 自动重连；失败退化为轮询兜底）。
    this.sse = new EventSource('/api/agent-board/stream')
    this.sse.onmessage = () => this.poll()
    this.visibilityCleanup = this.watchVisibility()
    window.addEventListener('resize', this.onResize)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }
    this.sse?.close()
    this.sse = null
    this.visibilityCleanup?.()
    this.visibilityCleanup = null
    window.removeEventListener('resize', this.onResize)
    this.leftUnsub?.()
    this.leftUnsub = null
    for (const unsub of this.convUnsubs.values()) unsub()
    this.convUnsubs.clear()
    // 只清内容不拆元素：root 由 React 持有，拆掉后 StrictMode 二次挂载会挂到
    // 已脱离文档的节点上。
    this.root.replaceChildren()
  }

  /** 标签页隐藏时暂停轮询（后台标签零请求）。 */
  private watchVisibility(): () => void {
    const onVisibility = (): void => {
      if (this.disposed) return
      if (document.hidden) this.stopPoll()
      else this.startPoll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }

  private startPoll(): void {
    if (this.timer !== undefined || this.disposed) return
    this.timer = window.setInterval(() => this.poll(), POLL_MS)
  }

  private stopPoll(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private poll(): void {
    if (this.fetching || this.disposed || document.hidden) return
    this.fetching = true
    void fetch('/api/agent-board/agents')
      .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.json() as Promise<AgentBoardSnapshot> })
      .then(snapshot => {
        if (this.disposed) return
        this.setOffline(false)
        this.applySnapshot(snapshot)
      })
      .catch(() => {
        if (!this.disposed) this.setOffline(true)
      })
      .finally(() => { this.fetching = false })
  }

  private setOffline(offline: boolean): void {
    this.offlineEl.style.display = offline ? 'block' : 'none'
    this.cardsEl.style.display = offline ? 'none' : 'flex'
    this.emptyEl.style.display = 'none'
  }

  // ------------------------------------------------------------ 分隔条拖拽

  private restoreSplit(): void {
    const containerWidth = this.root.clientWidth || window.innerWidth
    let width: number | null = null
    try {
      const raw = localStorage.getItem(SPLIT_KEY)
      if (raw !== null) {
        const n = Number.parseInt(raw, 10)
        if (Number.isFinite(n) && n > 0) width = n
      }
    } catch { /* storage unavailable: keep default */ }
    if (width === null) width = Math.floor(containerWidth * SPLIT_DEFAULT_RATIO)
    this.leftWidth = this.clampSplit(width, containerWidth)
    this.applySplit()
  }

  private clampSplit(width: number, containerWidth: number): number {
    const max = Math.max(SPLIT_MIN_PX, Math.floor(containerWidth * SPLIT_MAX_RATIO))
    const min = Math.min(SPLIT_MIN_PX, Math.max(120, containerWidth - 80))
    return Math.min(max, Math.max(min, Math.round(width)))
  }

  private applySplit(): void {
    const left = this.root.firstElementChild as HTMLElement | null
    if (left !== null) left.style.width = `${this.leftWidth}px`
  }

  private readonly onResize = (): void => {
    if (this.disposed) return
    const containerWidth = this.root.clientWidth || window.innerWidth
    this.leftWidth = this.clampSplit(this.leftWidth, containerWidth)
    this.applySplit()
  }

  private beginDrag(e: PointerEvent): void {
    if (e.button !== 0) return
    this.dragging = true
    this.dragPointerId = e.pointerId
    this.dragStartX = e.clientX
    this.dragStartWidth = this.leftWidth
    this.dragContainerWidth = this.root.clientWidth || window.innerWidth
    this.dividerEl.classList.add('swt-dragging')
    try {
      this.dividerEl.setPointerCapture(e.pointerId)
    } catch { /* capture is best-effort */ }
    window.addEventListener('pointermove', this.onDragMove)
    window.addEventListener('pointerup', this.onDragEnd, { once: true })
    window.addEventListener('pointercancel', this.onDragEnd, { once: true })
  }

  /** rAF 节流：高频 pointermove 合并为每帧一次写，避免一帧内多次整帧 reflow。 */
  private readonly onDragMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return
    // 向右拖 = 左变宽。
    this.dragLatestWidth = this.clampSplit(
      this.dragStartWidth + (e.clientX - this.dragStartX),
      this.dragContainerWidth,
    )
    if (this.dragRaf !== null) return
    this.dragRaf = requestAnimationFrame(() => {
      this.dragRaf = null
      this.leftWidth = this.dragLatestWidth
      this.applySplit()
    })
  }

  private readonly onDragEnd = (): void => {
    if (!this.dragging) return
    this.dragging = false
    if (this.dragRaf !== null) {
      cancelAnimationFrame(this.dragRaf)
      this.dragRaf = null
    }
    this.leftWidth = this.dragLatestWidth
    this.applySplit()
    window.removeEventListener('pointermove', this.onDragMove)
    this.dividerEl.classList.remove('swt-dragging')
    // 落盘（刷新恢复）。
    try { localStorage.setItem(SPLIT_KEY, String(this.leftWidth)) } catch { /* storage full: best-effort */ }
  }

  // ------------------------------------------------------------ 快照 → 卡片

  private applySnapshot(snapshot: AgentBoardSnapshot): void {
    this.snapshot = snapshot
    const now = snapshot.now
    // 直属子代理：parentSession === 当前会话 && depth === 1；复用 tree.ts 过滤
    // （running 恒保留；finished 超 30 分钟剔除）。
    const rows = snapshot.rows.filter(row =>
      row.parentSession === this.sessionId
      && row.depth === 1
      && keepRow(row, now),
    )
    // finished 防堆积：快照序（创建时间新→旧）最多 MAX_FINISHED_CARDS 条。
    let finishedKept = 0
    const kept: AgentSnapshotRow[] = []
    for (const row of rows) {
      if (row.status === 'finished') {
        if (finishedKept >= MAX_FINISHED_CARDS) continue
        finishedKept++
      }
      kept.push(row)
    }
    this.syncCards(kept)
  }

  /** 卡片集合对账：增删卡片 + 布局（展开/隐藏）+ 字段同步。 */
  private syncCards(rows: readonly AgentSnapshotRow[]): void {
    const ids = new Set(rows.map(r => r.id))
    // 移除消失的卡片（含对话订阅退订）。
    for (const [id, card] of this.cards) {
      if (ids.has(id)) continue
      this.convUnsubs.get(id)?.()
      this.convUnsubs.delete(id)
      this.convOn.delete(id)
      this.convData.delete(id)
      card.root.remove()
      this.cards.delete(id)
      if (this.expandedId === id) this.expandedId = null
    }
    // 新增卡片。
    for (const row of rows) {
      if (this.cards.has(row.id)) continue
      const card = this.createCard(row)
      this.cards.set(row.id, card)
      this.cardsEl.appendChild(card.root)
    }
    // 布局 + 字段。
    let running = 0
    for (const row of rows) {
      if (row.status === 'running') running++
      const card = this.cards.get(row.id)
      if (card !== undefined) this.layoutCard(card, row)
    }
    this.rightHeadCountEl.textContent = rows.length === 0 ? '· 0' : `· ${running}/${rows.length} 运行`
    // 空态：无直属子代理。
    this.emptyEl.style.display = rows.length === 0 ? 'block' : 'none'
  }

  private createCard(row: AgentSnapshotRow): CardEl {
    const root = document.createElement('div')
    root.className = 'swt-card'

    const head = document.createElement('div')
    head.className = 'swt-card-head'
    const dotEl = document.createElement('span')
    dotEl.className = 'swt-dot'
    const titleEl = document.createElement('span')
    titleEl.className = 'swt-card-title'
    titleEl.title = row.id
    const idEl = document.createElement('span')
    idEl.className = 'swt-card-id'
    idEl.textContent = row.id.slice(0, ID_PREFIX)
    const collapseBtnEl = document.createElement('button')
    collapseBtnEl.type = 'button'
    collapseBtnEl.className = 'swt-card-btn'
    collapseBtnEl.textContent = '▾ 收起'
    collapseBtnEl.title = '返回分屏均分'
    collapseBtnEl.style.display = 'none'
    const convBtnEl = document.createElement('button')
    convBtnEl.type = 'button'
    convBtnEl.className = 'swt-card-btn swt-btn-primary'
    convBtnEl.textContent = '对话'
    convBtnEl.title = '切换监控卡 / 该子代理对话流'
    const openBtnEl = document.createElement('button')
    openBtnEl.type = 'button'
    openBtnEl.className = 'swt-card-btn'
    openBtnEl.textContent = '跳转'
    openBtnEl.title = '打开该子代理会话'
    head.appendChild(dotEl)
    head.appendChild(titleEl)
    head.appendChild(idEl)
    head.appendChild(collapseBtnEl)
    head.appendChild(convBtnEl)
    head.appendChild(openBtnEl)

    const body = document.createElement('div')
    body.className = 'swt-card-body'
    const detailsEl = document.createElement('div')
    detailsEl.className = 'swt-details'
    const statusRow = document.createElement('div')
    statusRow.className = 'swt-detail-row'
    const statusLabel = document.createElement('span')
    statusLabel.className = 'swt-detail-label'
    statusLabel.textContent = '状态'
    const statusEl = document.createElement('span')
    statusEl.className = 'swt-detail-val'
    statusRow.appendChild(statusLabel)
    statusRow.appendChild(statusEl)
    const actionRow = document.createElement('div')
    actionRow.className = 'swt-detail-row'
    const actionLabel = document.createElement('span')
    actionLabel.className = 'swt-detail-label'
    actionLabel.textContent = '动作'
    const actionEl = document.createElement('span')
    actionEl.className = 'swt-detail-val'
    actionRow.appendChild(actionLabel)
    actionRow.appendChild(actionEl)
    const silentRow = document.createElement('div')
    silentRow.className = 'swt-detail-row'
    const silentLabel = document.createElement('span')
    silentLabel.className = 'swt-detail-label'
    silentLabel.textContent = '静默'
    const silentEl = document.createElement('span')
    silentEl.className = 'swt-detail-val'
    silentRow.appendChild(silentLabel)
    silentRow.appendChild(silentEl)
    const replyRow = document.createElement('div')
    replyRow.className = 'swt-detail-row'
    const replyLabel = document.createElement('span')
    replyLabel.className = 'swt-detail-label'
    replyLabel.textContent = '最新答复'
    const replyEl = document.createElement('span')
    replyEl.className = 'swt-detail-val swt-reply'
    replyRow.appendChild(replyLabel)
    replyRow.appendChild(replyEl)
    const waitingRow = document.createElement('div')
    waitingRow.className = 'swt-detail-row'
    const waitingLabel = document.createElement('span')
    waitingLabel.className = 'swt-detail-label'
    waitingLabel.textContent = '等待'
    const waitingEl = document.createElement('span')
    waitingEl.className = 'swt-detail-val swt-waiting-val'
    waitingRow.appendChild(waitingLabel)
    waitingRow.appendChild(waitingEl)
    detailsEl.appendChild(statusRow)
    detailsEl.appendChild(actionRow)
    detailsEl.appendChild(silentRow)
    detailsEl.appendChild(replyRow)
    detailsEl.appendChild(waitingRow)

    const conv = document.createElement('div')
    conv.className = 'swt-conv'
    conv.style.display = 'none'
    const convHead = document.createElement('div')
    convHead.className = 'swt-conv-head'
    convHead.textContent = '对话流（文本消息）'
    const convList = document.createElement('div')
    convList.className = 'swt-conv-list'
    conv.appendChild(convHead)
    conv.appendChild(convList)

    body.appendChild(detailsEl)
    body.appendChild(conv)
    root.appendChild(head)
    root.appendChild(body)

    // 单击（非按钮）＝展开聚焦/收起；拖动（滚动）超过阈值不算点击。
    let downX = 0
    let downY = 0
    root.addEventListener('pointerdown', (e) => {
      downX = e.clientX
      downY = e.clientY
    })
    root.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > CLICK_MOVE_PX) return
      this.toggleExpanded(row.id)
    })
    collapseBtnEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleExpanded(row.id)
    })
    convBtnEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleConversation(row.id)
    })
    openBtnEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.openSubagent(row)
    })

    return {
      id: row.id,
      root,
      dotEl,
      titleEl,
      idEl,
      statusEl,
      silentEl,
      actionEl,
      replyEl,
      waitingEl,
      convBtnEl,
      openBtnEl,
      collapseBtnEl,
      bodyEl: body,
      detailsEl,
      convEl: conv,
      convListEl: convList,
    }
  }

  /** 卡片布局：展开/隐藏、监控卡 ↔ 对话流显隐、按钮文案。 */
  private layoutCard(card: CardEl, row: AgentSnapshotRow): void {
    const expanded = this.expandedId === card.id
    const convOn = this.convOn.has(card.id)
    card.root.classList.toggle('swt-expanded', expanded)
    card.root.classList.toggle('swt-hidden', this.expandedId !== null && !expanded)
    card.collapseBtnEl.style.display = expanded ? '' : 'none'
    card.convBtnEl.textContent = convOn ? '监控' : '对话'
    // 分屏均分：监控卡 ↔ 对话流二选一；展开聚焦：完整信息 + 对话区同显。
    card.detailsEl.style.display = convOn && !expanded ? 'none' : ''
    card.convEl.style.display = convOn ? 'flex' : 'none'
    // 卡片状态。
    card.root.classList.toggle('swt-waiting', row.waiting !== undefined)
    card.root.classList.toggle('swt-finished', row.status === 'finished')
    // 状态行（statusText 复用 tree.ts：动作优先 > 停滞 > 完成 > 空闲）。
    const { text, stalled } = statusText(row, this.snapshot?.stallThresholdMs ?? 0)
    card.statusEl.textContent = text === '' ? (row.status === 'running' ? '运行中' : row.status) : text
    card.statusEl.className = `swt-detail-val${stalled ? ' swt-stall' : ''}`
    // 状态色点（照 tree.ts stClass：等待→黄 / 停滞→红 / 完成→蓝(已读灰) / 运行→绿 / 空闲→灰）。
    const stClass = row.waiting !== undefined ? 'swt-st-waiting'
      : stalled ? 'swt-st-stall'
      : row.status === 'finished' ? (isViewed(row.id) ? 'swt-st-idle' : 'swt-st-finished')
      : row.status === 'running' ? 'swt-st-running'
      : 'swt-st-idle'
    card.dotEl.className = `swt-dot ${stClass}`
    // 标题：label 或 title 或 id 前 8 位。
    card.titleEl.textContent = row.label ?? row.title ?? row.id.slice(0, ID_PREFIX)
    // 动作。
    card.actionEl.textContent = row.action !== undefined
      ? (row.action.kind === 'tool' ? row.action.text : '输出中…')
      : '—'
    // 静默（仅 running 显示）。
    card.silentEl.textContent = row.status === 'running' ? formatDuration(row.silentMs) : '—'
    // 最新答复。
    card.replyEl.textContent = row.lastReply ?? '—'
    // 等待人工。
    card.waitingEl.textContent = row.waiting ?? '—'
    // 对话缓存：监控卡模式也要保证缓存存在（展开/切对话时即出）。
    if (!this.convData.has(card.id)) this.convData.set(card.id, { state: 'loading', messages: [], fallback: null })
    if (convOn) this.ensureConversation(card)
  }

  // ------------------------------------------------------------ 交互

  private toggleExpanded(id: string): void {
    this.expandedId = this.expandedId === id ? null : id
    if (this.expandedId === id) {
      // 展开聚焦：完整信息 + 对话区。
      this.convOn.add(id)
      const card = this.cards.get(id)
      if (card !== undefined) this.ensureConversation(card)
    }
    this.reapplyCards()
  }

  private toggleConversation(id: string): void {
    if (this.convOn.has(id)) this.convOn.delete(id)
    else {
      this.convOn.add(id)
      const card = this.cards.get(id)
      if (card !== undefined) this.ensureConversation(card)
    }
    this.reapplyCards()
  }

  /** 打开子代理会话（复用 tree.ts openBoardSession + 已读标记）。失败给红色反馈。 */
  private openSubagent(row: AgentSnapshotRow): void {
    markViewed(row.id)
    const card = this.cards.get(row.id)
    card?.root.classList.add('swt-opening')
    void openBoardSession(this.ctx, row.id, row.parentSession).then(ok => {
      const c = this.cards.get(row.id)
      if (c === undefined) return
      if (ok !== true) {
        c.root.classList.remove('swt-opening')
        c.root.classList.add('swt-open-failed')
        c.root.title = '打开会话失败（会话可能已不存在），稍后重试'
      }
    })
  }

  /** 展开/收起/对话切换后统一重排（用最近快照）。 */
  private reapplyCards(): void {
    if (this.snapshot === null) return
    this.applySnapshot(this.snapshot)
  }

  // ------------------------------------------------------------ 对话流

  /** 主会话对话流（左栏）：binding 订阅优先，降级 session.history RPC。 */
  private loadLeftConversation(): void {
    this.leftUnsub?.()
    this.leftUnsub = null
    const binding = this.ctx.sessions.binding(this.sessionId)
    if (binding !== undefined) {
      this.leftUnsub = binding.session.subscribe(() => this.renderLeftFromSession(binding.session))
      this.renderLeftFromSession(binding.session)
      return
    }
    // 降级：host RPC。
    void fetchSessionHistory(this.sessionId).then(msgs => {
      if (this.disposed) return
      if (msgs !== null) this.renderLeftMessages(msgs)
      else this.renderLeftHint('对话不可用')
    })
  }

  private renderLeftFromSession(session: SessionFace): void {
    const snap = session.getSnapshot()
    this.renderLeftMessages(collectMessages(snap.nodes), snap.pending)
  }

  private renderLeftMessages(
    messages: readonly TextMessage[],
    pending?: readonly PendingInteraction[],
  ): void {
    if (this.disposed) return
    const el = this.leftBodyEl
    const stick = this.leftStickBottom || el.scrollTop + el.clientHeight >= el.scrollHeight - 80
    el.replaceChildren()
    if (messages.length === 0) {
      el.appendChild(hintLine('该会话暂无对话消息'))
      this.leftStickBottom = true
    } else {
      for (const msg of messages) el.appendChild(renderMessage(msg))
      if (stick) {
        this.leftStickBottom = true
        el.scrollTop = el.scrollHeight
      } else {
        this.leftStickBottom = false
      }
    }
    // 等待人工的提问/审批卡（照对话页 composer 占位位置：对话流下方）。
    this.renderInteractions(pending ?? [])
  }

  private renderLeftHint(text: string): void {
    if (this.disposed) return
    this.leftBodyEl.replaceChildren(hintLine(text))
    this.renderInteractions([])
  }

  // ------------------------------------------------------------ 等待人工卡片

  private renderInteractions(pending: readonly PendingInteraction[]): void {
    if (this.disposed) return
    this.interactEl.replaceChildren()
    if (pending.length === 0) {
      this.interactEl.style.display = 'none'
      // 清理已结算 wait 的选中态/输入（防泄漏）。
      const live = new Set(pending.map(w => w.key))
      for (const key of this.questionSel.keys()) {
        if (![...live].some(l => key.startsWith(l))) this.questionSel.delete(key)
      }
      for (const key of this.questionInputs.keys()) {
        if (![...live].some(l => key.startsWith(l))) this.questionInputs.delete(key)
      }
      return
    }
    this.interactEl.style.display = 'flex'
    for (const wait of pending) {
      if (wait.kind === 'question') this.interactEl.appendChild(this.renderQuestionCard(wait))
      else if (wait.kind === 'approval') this.interactEl.appendChild(this.renderApprovalCard(wait))
    }
  }

  /** 提问卡：问题/详情/选项（单选或多选）/自由文本 + 提交/取消（应答协议照 ui-user-questions）。 */
  private renderQuestionCard(wait: Extract<PendingInteraction, { kind: 'question' }>): HTMLDivElement {
    const payload = wait.payload as { readonly questions?: readonly QuestionItemLike[] }
    const items = payload.questions ?? []
    const card = document.createElement('div')
    card.className = 'swt-qcard'
    const head = document.createElement('div')
    head.className = 'swt-qcard-head'
    head.textContent = '❓ 等待你的判断'
    const body = document.createElement('div')
    body.className = 'swt-qcard-body'
    const errEl = document.createElement('div')
    errEl.className = 'swt-qcard-err'
    errEl.style.display = 'none'
    const actions = document.createElement('div')
    actions.className = 'swt-qcard-actions'
    const submit = document.createElement('button')
    submit.type = 'button'
    submit.className = 'swt-qcard-btn swt-qcard-primary'
    submit.textContent = '提交'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'swt-qcard-btn'
    cancel.textContent = '取消'
    actions.appendChild(submit)
    actions.appendChild(cancel)
    card.appendChild(head)
    card.appendChild(body)
    card.appendChild(errEl)
    card.appendChild(actions)

    const busy = (b: boolean): void => {
      submit.disabled = b
      cancel.disabled = b
    }
    // 每道题：选项按钮（multiSelect 可多选）或自由文本输入。
    for (const item of items) {
      const qEl = document.createElement('div')
      qEl.className = 'swt-qcard-item'
      const title = document.createElement('div')
      title.className = 'swt-qcard-q'
      const questionText = item.question ?? ''
      title.textContent = item.header !== undefined && item.header !== ''
        ? `${item.header}：${questionText}`
        : questionText
      qEl.appendChild(title)
      if (item.detail !== undefined && item.detail !== '') {
        const d = document.createElement('div')
        d.className = 'swt-qcard-detail'
        d.textContent = item.detail
        qEl.appendChild(d)
      }
      const opts = item.options ?? []
      const selKey = `${wait.key}:${item.id ?? '?'}`
      let sel = this.questionSel.get(selKey)
      if (sel === undefined) {
        sel = new Set()
        this.questionSel.set(selKey, sel)
      }
      if (opts.length === 0) {
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'swt-qcard-input'
        input.placeholder = '输入你的回答…'
        qEl.appendChild(input)
        this.questionInputs.set(selKey, input)
      } else {
        const optionEls: HTMLButtonElement[] = []
        const refresh = (): void => {
          for (const oEl of optionEls) {
            oEl.classList.toggle('selected', sel!.has(oEl.dataset.label ?? ''))
          }
          submit.disabled = items.every(it => {
            const s = this.questionSel.get(`${wait.key}:${it.id ?? '?'}`)
            return (s === undefined || s.size === 0)
          })
        }
        for (const opt of opts) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'swt-qcard-option'
          b.dataset.label = opt.label ?? ''
          b.textContent = opt.label ?? ''
          if (opt.description !== undefined) b.title = opt.description
          b.addEventListener('click', () => {
            const label = opt.label ?? ''
            if (item.multiSelect === true) {
              if (sel!.has(label)) sel!.delete(label)
              else sel!.add(label)
            } else {
              sel!.clear()
              sel!.add(label)
            }
            refresh()
          })
          optionEls.push(b)
          qEl.appendChild(b)
        }
        refresh()
      }
      body.appendChild(qEl)
    }
    submit.addEventListener('click', () => {
      busy(true)
      errEl.style.display = 'none'
      const answers = items.map(it => {
        const key = `${wait.key}:${it.id ?? '?'}`
        const s = this.questionSel.get(key)
        const input = this.questionInputs.get(key)
        return {
          id: it.id ?? '',
          selected: s !== undefined ? [...s] : [],
          ...(input !== undefined && input.value.trim() !== '' ? { custom: input.value.trim() } : {}),
        }
      })
      void wait.respond({ ok: true, value: { sessionId: wait.sessionId, answer: { answers } } })
        .catch((e: unknown) => {
          busy(false)
          errEl.textContent = `提交失败：${e instanceof Error ? e.message : String(e)}`
          errEl.style.display = 'block'
        })
    })
    cancel.addEventListener('click', () => {
      busy(true)
      errEl.style.display = 'none'
      void wait.respond({
        ok: false,
        error: { code: 'cancelled', message: '用户取消了提问', details: {} },
      }).catch((e: unknown) => {
        busy(false)
        errEl.textContent = `取消失败：${e instanceof Error ? e.message : String(e)}`
        errEl.style.display = 'block'
      })
    })
    return card
  }

  /** 审批卡：理由/工具名 + 允许一次/拒绝（应答协议照 ui-conversation ApprovalPanel）。 */
  private renderApprovalCard(wait: Extract<PendingInteraction, { kind: 'approval' }>): HTMLDivElement {
    const payload = wait.payload as {
      readonly toolName?: string
      readonly reason?: string
      readonly approvalId?: string
    }
    const card = document.createElement('div')
    card.className = 'swt-acard'
    const head = document.createElement('div')
    head.className = 'swt-acard-head'
    head.textContent = '⏳ 等待批准'
    const headline = document.createElement('div')
    headline.className = 'swt-acard-headline'
    headline.textContent = payload.reason ?? `请求批准执行工具 ${payload.toolName ?? ''}`
    const errEl = document.createElement('div')
    errEl.className = 'swt-acard-err'
    errEl.style.display = 'none'
    const actions = document.createElement('div')
    actions.className = 'swt-acard-actions'
    const reject = document.createElement('button')
    reject.type = 'button'
    reject.className = 'swt-acard-btn'
    reject.textContent = '拒绝'
    const allow = document.createElement('button')
    allow.type = 'button'
    allow.className = 'swt-acard-btn swt-acard-primary'
    allow.textContent = '允许一次'
    actions.appendChild(reject)
    actions.appendChild(allow)
    card.appendChild(head)
    card.appendChild(headline)
    card.appendChild(errEl)
    card.appendChild(actions)
    const answer = (outcome: 'allowed-once' | 'rejected'): void => {
      reject.disabled = true
      allow.disabled = true
      errEl.style.display = 'none'
      void wait.respond({
        ok: true,
        value: { sessionId: wait.sessionId, approvalId: payload.approvalId ?? '', outcome },
      }).catch((e: unknown) => {
        reject.disabled = false
        allow.disabled = false
        errEl.textContent = `应答失败：${e instanceof Error ? e.message : String(e)}`
        errEl.style.display = 'block'
      })
    }
    reject.addEventListener('click', () => answer('rejected'))
    allow.addEventListener('click', () => answer('allowed-once'))
    return card
  }

  /** 子代理对话流：binding 订阅 → session.history RPC → lastReply 兜底。 */
  private ensureConversation(card: CardEl): void {
    const cached = this.convData.get(card.id)
    if (cached !== undefined && cached.state !== 'loading') {
      this.renderConversation(card, cached)
      return
    }
    if (cached === undefined) {
      this.convData.set(card.id, { state: 'loading', messages: [], fallback: null })
    }
    this.renderConversation(card, this.convData.get(card.id)!)
    const binding = this.ctx.sessions.binding(card.id as SessionId)
    if (binding !== undefined) {
      if (!this.convUnsubs.has(card.id)) {
        this.convUnsubs.set(card.id, binding.session.subscribe(() => {
          const c = this.cards.get(card.id)
          if (c === undefined) return
          const data: ConversationData = {
            state: 'ok',
            messages: collectMessages(binding.session.getSnapshot().nodes),
            fallback: null,
          }
          this.convData.set(card.id, data)
          this.renderConversation(c, data)
        }))
      }
      const data: ConversationData = {
        state: 'ok',
        messages: collectMessages(binding.session.getSnapshot().nodes),
        fallback: null,
      }
      this.convData.set(card.id, data)
      this.renderConversation(card, data)
      return
    }
    // 降级：host RPC session.history。
    void fetchSessionHistory(card.id).then(msgs => {
      if (this.disposed || !this.cards.has(card.id)) return
      const row = this.snapshot?.rows.find(r => r.id === card.id)
      const data: ConversationData = msgs !== null
        ? { state: 'ok', messages: msgs, fallback: null }
        : { state: 'fail', messages: [], fallback: row?.lastReply ?? null }
      this.convData.set(card.id, data)
      const c = this.cards.get(card.id)
      if (c !== undefined) this.renderConversation(c, data)
    })
  }

  private renderConversation(card: CardEl, data: ConversationData): void {
    if (this.disposed || !card.convEl.isConnected) return
    const list = card.convListEl
    const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40
    list.replaceChildren()
    if (data.state === 'loading') {
      list.appendChild(hintLine('加载对话…'))
      return
    }
    if (data.state === 'fail') {
      list.appendChild(hintLine(
        data.fallback !== null ? `对话不可用 · 最新答复：${data.fallback}` : '对话不可用',
      ))
      return
    }
    if (data.messages.length === 0) {
      list.appendChild(hintLine('该子代理暂无对话消息'))
      return
    }
    for (const msg of data.messages) list.appendChild(renderMessage(msg))
    if (stick) list.scrollTop = list.scrollHeight
  }
}
