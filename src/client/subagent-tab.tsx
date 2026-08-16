/**
 * 会话页「子代理」tab：左主右子分屏视图。
 *
 * 布局：左侧 = 当前主 agent 会话的完整对话流（markdown 文本消息，只读 +
 * 底部等待人工交互区）；右侧 = 该会话直属子代理（parentSession === sessionId
 * 且 depth === 1）的「agent 容器」列表——每个容器固定高度（均分）、内部滚动，
 * 内容 = 该子代理自己的真实对话流（markdown）+ 该子代理挂起的提问/审批卡。
 * 中间一条可拖拽分隔条（左宽右窄，宽度持久化 localStorage
 * `dsh.agentBoard.tabSplit.v1`，向右拖 = 左变宽）。
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
 * 对话渲染：主会话走 binding（ctx.sessions.binding → snapshot.nodes 文本消息，
 * 可订阅实时更新）；子代理会话无 binding（eligible 仅限 current/列表内），
 * 走 host RPC `POST /api/session.history`（result.value.events 的
 * user/assistant/message 文本）+ 活动变化节流刷新。
 *
 * 原地应答：挂起提问/审批经 mux 流 `GET /api/events.mux`（SSE，连接即重放
 * 全部挂起帧、rpcId 稳定）维护注册表，应答走 `POST /api/respond`
 * client-response 信封（协议逐字段对齐 ui-user-questions PendingQuestion /
 * ui-conversation ApprovalPanel）。快照 pending 缺失时从 action.text
 * （ask_user_question: {json}）解析提问内容兜底展示。
 *
 * 交互：卡片头 = 状态点/标题/状态/静默/等待高亮 + 「跳转」按钮
 * （openBoardSession，复用 tree.ts，含已读标记）；无展开交互——每个
 * agent 容器直接就是可读可答的对话。
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
/** 子代理对话流刷新节流（ms）：活动变化后至少间隔这么久才重拉 history。 */
const CARD_REFRESH_MIN_MS = 4000

/** 一条纯文本对话消息（自绘轻量对话用）。 */
interface TextMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
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

/** mux 流（/api/events.mux）帧的最小结构面。 */
interface MuxFrameEnvelope {
  readonly rpcId?: string
  readonly payload?: {
    readonly type?: string
    readonly sessionId?: string
    readonly questions?: readonly QuestionItemLike[]
    readonly questionRpcId?: string
    readonly approvalId?: string
    readonly toolName?: string
    readonly reason?: string
  }
}

/** 应答载荷（client-response 的 result 槽）。 */
type PendingResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** 一张子代理窗格的 DOM 引用。 */
interface CardEl {
  readonly id: string
  readonly root: HTMLDivElement
  readonly dotEl: HTMLSpanElement
  readonly titleEl: HTMLSpanElement
  readonly idEl: HTMLSpanElement
  readonly statusEl: HTMLSpanElement
  readonly silentEl: HTMLSpanElement
  readonly openBtnEl: HTMLButtonElement
  readonly bodyEl: HTMLDivElement
  readonly convListEl: HTMLDivElement
}

/** 一个可应答的挂起交互（快照 PendingWait 与 mux 帧的统一面）。 */
interface PendingFace {
  readonly key: string
  readonly sessionId: string
  readonly kind: 'question' | 'approval'
  /** question 载荷。 */
  readonly questions?: readonly QuestionItemLike[]
  /** approval 载荷。 */
  readonly toolName?: string
  readonly reason?: string
  readonly approvalId?: string
  /** 发送应答（true = 宿主接受）。 */
  respond(result: PendingResult): Promise<boolean>
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
/* 右侧 = 子代理「agent 容器」列表：每容器固定高度均分、内部滚动 */
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
}
.swt-card:hover { border-color: var(--dsw-alias-border-l2, rgba(154, 208, 255, 0.4)); }
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
.swt-card-status {
  flex: none;
  max-width: 34%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary, #9aa0a6);
  font-size: 11px;
}
.swt-card-status.swt-stall { color: #f87171; font-weight: 700; }
.swt-card-status.swt-waiting-val { color: #fbbf24; }
.swt-card-silent { flex: none; color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 11px; }
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
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.swt-conv-list { flex: 1; padding: 6px 8px; }
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
  .swt-card-status { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-card-status.swt-stall { color: #dc2626; }
  .swt-card-status.swt-waiting-val { color: #b45309; }
  .swt-card-silent { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-card-btn { color: var(--dsw-alias-label-secondary, #6b7280); }
  .swt-card-btn:hover { color: var(--dsw-alias-label-primary, #111827); background: rgba(0, 0, 0, 0.05); }
  .swt-card-btn.swt-btn-primary { color: var(--dsw-alias-brand-primary, #2563eb); }
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

/** host RPC session.history：子代理会话（无 binding）的文本消息来源。 */
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

/** POST /api/respond：client-response 信封（宿主应答通道）。 */
async function respondRpc(rpcId: string, result: PendingResult): Promise<boolean> {
  try {
    const res = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
    })
    if (!res.ok) return false
    const body = await res.json() as { accepted?: boolean }
    return body.accepted === true
  } catch {
    return false
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

/** 从快照行的 action.text（ask_user_question: {json}）解析提问内容（兜底展示用）。 */
function questionsFromAction(row: AgentSnapshotRow): readonly QuestionItemLike[] | null {
  if (row.action?.kind !== 'tool') return null
  const idx = row.action.text.indexOf(':')
  if (idx < 0) return null
  const jsonText = row.action.text.slice(idx + 1).trim()
  try {
    const parsed = JSON.parse(jsonText) as { questions?: readonly QuestionItemLike[] }
    return Array.isArray(parsed.questions) && parsed.questions.length > 0 ? parsed.questions : null
  } catch {
    return null
  }
}

/**
 * 提问卡（选项单选/多选或自由文本 + 提交/取消）。应答协议照
 * ui-user-questions PendingQuestion：respond{ok,value:{sessionId,answer}}。
 * @param sel 选中态（${face.key}:${questionId} → label 集合，跨渲染保持）。
 * @param inputs 无选项题目的自由文本输入（同上 key）。
 * @param onAnswered 应答成功后回调（刷新所在区域）。
 */
function buildQuestionCard(
  face: PendingFace,
  sel: Map<string, Set<string>>,
  inputs: Map<string, HTMLInputElement>,
  onAnswered: () => void,
): HTMLDivElement {
  const items = face.questions ?? []
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
    const selKey = `${face.key}:${item.id ?? '?'}`
    let selected = sel.get(selKey)
    if (selected === undefined) {
      selected = new Set()
      sel.set(selKey, selected)
    }
    if (opts.length === 0) {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'swt-qcard-input'
      input.placeholder = '输入你的回答…'
      qEl.appendChild(input)
      inputs.set(selKey, input)
    } else {
      const optionEls: HTMLButtonElement[] = []
      const refresh = (): void => {
        for (const oEl of optionEls) {
          oEl.classList.toggle('selected', selected!.has(oEl.dataset.label ?? ''))
        }
        submit.disabled = items.every(it => {
          const s = sel.get(`${face.key}:${it.id ?? '?'}`)
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
            if (selected!.has(label)) selected!.delete(label)
            else selected!.add(label)
          } else {
            selected!.clear()
            selected!.add(label)
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
      const key = `${face.key}:${it.id ?? '?'}`
      const s = sel.get(key)
      const input = inputs.get(key)
      return {
        id: it.id ?? '',
        selected: s !== undefined ? [...s] : [],
        ...(input !== undefined && input.value.trim() !== '' ? { custom: input.value.trim() } : {}),
      }
    })
    void face.respond({ ok: true, value: { sessionId: face.sessionId, answer: { answers } } })
      .then(accepted => {
        if (!accepted) throw new Error('宿主拒绝了应答')
        onAnswered()
      })
      .catch((e: unknown) => {
        busy(false)
        errEl.textContent = `提交失败：${e instanceof Error ? e.message : String(e)}`
        errEl.style.display = 'block'
      })
  })
  cancel.addEventListener('click', () => {
    busy(true)
    errEl.style.display = 'none'
    void face.respond({
      ok: false,
      error: { code: 'cancelled', message: '用户取消了提问', details: {} },
    })
      .then(accepted => {
        if (!accepted) throw new Error('宿主拒绝了取消')
        onAnswered()
      })
      .catch((e: unknown) => {
        busy(false)
        errEl.textContent = `取消失败：${e instanceof Error ? e.message : String(e)}`
        errEl.style.display = 'block'
      })
  })
  return card
}

/** 审批卡：理由/工具名 + 允许一次/拒绝（应答协议照 ui-conversation ApprovalPanel）。 */
function buildApprovalCard(face: PendingFace, onAnswered: () => void): HTMLDivElement {
  const card = document.createElement('div')
  card.className = 'swt-acard'
  const head = document.createElement('div')
  head.className = 'swt-acard-head'
  head.textContent = '⏳ 等待批准'
  const headline = document.createElement('div')
  headline.className = 'swt-acard-headline'
  headline.textContent = face.reason ?? `请求批准执行工具 ${face.toolName ?? ''}`
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
    void face.respond({
      ok: true,
      value: { sessionId: face.sessionId, approvalId: face.approvalId ?? '', outcome },
    })
      .then(accepted => {
        if (!accepted) throw new Error('宿主拒绝了应答')
        onAnswered()
      })
      .catch((e: unknown) => {
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
  // data-conversation-composer-overlay：让会话容器把 viewArea 约束为固定高度
  // （flex 1 1 0 + min-height 0 + overflow hidden），本视图内部滚动——否则
  // 容器随内容无限长（与 TrajectoryView 同一机制）。
  return <div ref={ref} className="swt-root" data-conversation-composer-overlay="" />
}

/** 子代理分屏视图控制器：布局 + 拖拽 + 轮询/SSE/mux + 渲染。 */
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
  /** 子代理对话流缓存（session.history RPC 结果）。 */
  private readonly cardConv = new Map<string, {
    readonly msgs: readonly TextMessage[]
    state: 'loading' | 'ok' | 'fail'
    fetchedAt: number
    lastActivity: number
  }>()
  /** 正在拉 history 的卡片 id（防并发重复请求）。 */
  private readonly fetchingHistory = new Set<string>()
  /** mux 注册表：sessionId → 挂起交互（rpcId 稳定，可原地应答）。 */
  private readonly muxPending = new Map<string, PendingFace[]>()
  /** 提问卡选中态：`${face.key}:${questionId}` → 已选 label 集合。 */
  private readonly questionSel = new Map<string, Set<string>>()
  /** 无选项提问的自由文本输入：`${face.key}:${questionId}` → input。 */
  private readonly questionInputs = new Map<string, HTMLInputElement>()
  /** 主会话 binding 订阅。 */
  private leftUnsub: (() => void) | null = null

  private snapshot: AgentBoardSnapshot | null = null
  /** 左栏宽度（px）。 */
  private leftWidth = 0
  /** 左栏是否粘底（有新消息自动滚到底）。 */
  private leftStickBottom = true

  private timer: number | undefined
  private fetching = false
  private sse: EventSource | null = null
  private muxWs: WebSocket | null = null
  private muxRetryTimer: number | undefined
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
    rightHint.textContent = '直属子代理 · 各自容器内滑动 · 挂起可原地应答'
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
    // SSE：快照变化即时刷新（EventSource 自动重连；失败退化为轮询兜底）。
    this.sse = new EventSource('/api/agent-board/stream')
    this.sse.onmessage = () => this.poll()
    // mux：挂起提问/审批注册表（连接即重放全部挂起帧，rpcId 稳定）——
    // 子代理会话无 binding，这是原地应答的唯一通道。该路由仅支持 WebSocket。
    this.connectMux()
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
    if (this.muxRetryTimer !== undefined) {
      window.clearTimeout(this.muxRetryTimer)
      this.muxRetryTimer = undefined
    }
    this.muxWs?.close()
    this.muxWs = null
    this.visibilityCleanup?.()
    this.visibilityCleanup = null
    window.removeEventListener('resize', this.onResize)
    this.leftUnsub?.()
    this.leftUnsub = null
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

  // ------------------------------------------------------------ mux 注册表

  /** 连接 mux WebSocket（失败 1.5s 后自动重连；宿主在每次连接时重放挂起帧）。 */
  private connectMux(): void {
    if (this.disposed) return
    try {
      const url = new URL('/api/events.mux', window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url)
      this.muxWs = ws
      ws.onmessage = (e) => this.onMuxMessage(e)
      ws.onclose = () => {
        if (this.muxWs !== ws) return
        this.muxWs = null
        if (!this.disposed && this.muxRetryTimer === undefined) {
          this.muxRetryTimer = window.setTimeout(() => {
            this.muxRetryTimer = undefined
            this.connectMux()
          }, 1500)
        }
      }
      ws.onerror = () => { try { ws.close() } catch { /* 关闭由 onclose 接管重连 */ } }
    } catch {
      // WebSocket 不可用：降级为轮询 + 快照 waiting（无 rpcId 时提问卡只读展示）。
    }
  }

  /** mux 帧：维护 sessionId → 挂起交互（question/approval，含稳定 rpcId）。 */
  private readonly onMuxMessage = (e: MessageEvent): void => {
    if (this.disposed) return
    let frame: MuxFrameEnvelope
    try {
      frame = JSON.parse(e.data as string) as MuxFrameEnvelope
    } catch {
      return // 非 JSON 帧（如心跳注释行）忽略
    }
    const payload = frame.payload
    if (payload === undefined || typeof payload.sessionId !== 'string') return
    const sid = payload.sessionId
    if (payload.type === 'question/requested') {
      if (typeof frame.rpcId !== 'string') return
      const entry: PendingFace = {
        key: `q:${frame.rpcId}`,
        sessionId: sid,
        kind: 'question',
        questions: payload.questions ?? [],
        respond: (result) => respondRpc(frame.rpcId as string, result),
      }
      const list = (this.muxPending.get(sid) ?? []).filter(p => p.kind !== 'question')
      list.push(entry)
      this.muxPending.set(sid, list)
      this.onPendingChanged(sid)
    } else if (payload.type === 'question/resolved') {
      const key = `q:${payload.questionRpcId ?? ''}`
      const list = this.muxPending.get(sid)
      if (list !== undefined) {
        const kept = list.filter(p => p.key !== key)
        if (kept.length === 0) this.muxPending.delete(sid)
        else this.muxPending.set(sid, kept)
        this.onPendingChanged(sid)
      }
    } else if (payload.type === 'approval/requested') {
      if (typeof frame.rpcId !== 'string') return
      const entry: PendingFace = {
        key: `a:${payload.approvalId ?? frame.rpcId}`,
        sessionId: sid,
        kind: 'approval',
        toolName: payload.toolName,
        reason: payload.reason,
        approvalId: payload.approvalId,
        respond: (result) => respondRpc(frame.rpcId as string, result),
      }
      const list = (this.muxPending.get(sid) ?? []).filter(p => p.kind !== 'approval')
      list.push(entry)
      this.muxPending.set(sid, list)
      this.onPendingChanged(sid)
    } else if (payload.type === 'approval/resolved') {
      const key = `a:${payload.approvalId ?? ''}`
      const list = this.muxPending.get(sid)
      if (list !== undefined) {
        const kept = list.filter(p => p.key !== key)
        if (kept.length === 0) this.muxPending.delete(sid)
        else this.muxPending.set(sid, kept)
        this.onPendingChanged(sid)
      }
    }
  }

  private onPendingChanged(sessionId: string): void {
    if (this.disposed) return
    // 主会话的挂起走 binding 快照渲染（事件驱动）；子代理卡片立即重排。
    if (sessionId !== this.sessionId) this.reapplyCards()
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

  /** 卡片集合对账：增删卡片 + 头部字段 + 对话流刷新 + 挂起卡渲染。 */
  private syncCards(rows: readonly AgentSnapshotRow[]): void {
    const ids = new Set(rows.map(r => r.id))
    // 移除消失的卡片。
    for (const [id, card] of this.cards) {
      if (ids.has(id)) continue
      this.cardConv.delete(id)
      this.fetchingHistory.delete(id)
      card.root.remove()
      this.cards.delete(id)
    }
    // 新增卡片。
    for (const row of rows) {
      if (this.cards.has(row.id)) continue
      const card = this.createCard(row)
      this.cards.set(row.id, card)
      this.cardsEl.appendChild(card.root)
    }
    // 头部字段 + 对话流 + 挂起卡。
    let running = 0
    for (const row of rows) {
      if (row.status === 'running') running++
      const card = this.cards.get(row.id)
      if (card !== undefined) {
        this.updateCardHead(card, row)
        this.maybeRefreshConversation(card, row)
      }
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
    const statusEl = document.createElement('span')
    statusEl.className = 'swt-card-status'
    const silentEl = document.createElement('span')
    silentEl.className = 'swt-card-silent'
    const openBtnEl = document.createElement('button')
    openBtnEl.type = 'button'
    openBtnEl.className = 'swt-card-btn swt-btn-primary'
    openBtnEl.textContent = '跳转'
    openBtnEl.title = '打开该子代理会话'
    head.appendChild(dotEl)
    head.appendChild(titleEl)
    head.appendChild(idEl)
    head.appendChild(statusEl)
    head.appendChild(silentEl)
    head.appendChild(openBtnEl)

    const body = document.createElement('div')
    body.className = 'swt-card-body'
    const convList = document.createElement('div')
    convList.className = 'swt-conv-list'
    body.appendChild(convList)
    root.appendChild(head)
    root.appendChild(body)

    openBtnEl.addEventListener('click', () => this.openSubagent(row))

    return {
      id: row.id,
      root,
      dotEl,
      titleEl,
      idEl,
      statusEl,
      silentEl,
      openBtnEl,
      bodyEl: body,
      convListEl: convList,
    }
  }

  /** 卡片头：状态点/标题/状态/静默/等待高亮。 */
  private updateCardHead(card: CardEl, row: AgentSnapshotRow): void {
    const threshold = this.snapshot?.stallThresholdMs ?? 0
    const { text, stalled } = statusText(row, threshold)
    const waiting = row.waiting !== undefined
    card.root.classList.toggle('swt-waiting', waiting)
    card.root.classList.toggle('swt-finished', row.status === 'finished')
    // 状态色点（照 tree.ts stClass：等待→黄 / 停滞→红 / 完成→蓝(已读灰) / 运行→绿 / 空闲→灰）。
    const stClass = waiting ? 'swt-st-waiting'
      : stalled ? 'swt-st-stall'
      : row.status === 'finished' ? (isViewed(row.id) ? 'swt-st-idle' : 'swt-st-finished')
      : row.status === 'running' ? 'swt-st-running'
      : 'swt-st-idle'
    card.dotEl.className = `swt-dot ${stClass}`
    // 标题：label 或 title 或 id 前 8 位。
    card.titleEl.textContent = row.label ?? row.title ?? row.id.slice(0, ID_PREFIX)
    // 状态文本（等待/动作/停滞/完成/空闲）。
    card.statusEl.textContent = waiting
      ? '🔔 等你判断'
      : (text === '' ? (row.status === 'running' ? '运行中' : row.status) : text)
    card.statusEl.className = `swt-card-status${waiting ? ' swt-waiting-val' : ''}${stalled ? ' swt-stall' : ''}`
    // 静默（仅 running 显示）。
    card.silentEl.textContent = row.status === 'running' ? `静默 ${formatDuration(row.silentMs)}` : ''
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

  // ------------------------------------------------------------ 卡片对话流

  /** 子代理对话流：session.history RPC + 活动变化节流刷新（无 binding）。 */
  private maybeRefreshConversation(card: CardEl, row: AgentSnapshotRow): void {
    const cached = this.cardConv.get(card.id)
    const needFetch = cached === undefined
      || cached.state === 'fail'
      || (cached.state === 'ok' && row.lastActivity !== cached.lastActivity
        && Date.now() - cached.fetchedAt >= CARD_REFRESH_MIN_MS)
    if (!needFetch) {
      this.renderCardConversation(card, row)
      return
    }
    if (this.fetchingHistory.has(card.id)) {
      this.renderCardConversation(card, row)
      return
    }
    this.fetchingHistory.add(card.id)
    if (cached === undefined) {
      this.cardConv.set(card.id, { msgs: [], state: 'loading', fetchedAt: 0, lastActivity: row.lastActivity })
    }
    this.renderCardConversation(card, row)
    void fetchSessionHistory(card.id).then(msgs => {
      this.fetchingHistory.delete(card.id)
      if (this.disposed || !this.cards.has(card.id)) return
      this.cardConv.set(card.id, {
        msgs: msgs ?? [],
        state: msgs !== null ? 'ok' : 'fail',
        fetchedAt: Date.now(),
        lastActivity: row.lastActivity,
      })
      this.renderCardConversation(card, row)
    })
  }

  /** 立即重拉该卡片对话流（应答成功后刷新，让答案出现在对话里）。 */
  private refreshCardConversationNow(card: CardEl, row: AgentSnapshotRow): void {
    if (this.fetchingHistory.has(card.id)) return
    this.fetchingHistory.add(card.id)
    this.cardConv.set(card.id, { msgs: [], state: 'loading', fetchedAt: 0, lastActivity: row.lastActivity })
    this.renderCardConversation(card, row)
    void fetchSessionHistory(card.id).then(msgs => {
      this.fetchingHistory.delete(card.id)
      if (this.disposed || !this.cards.has(card.id)) return
      this.cardConv.set(card.id, {
        msgs: msgs ?? [],
        state: msgs !== null ? 'ok' : 'fail',
        fetchedAt: Date.now(),
        lastActivity: row.lastActivity,
      })
      this.renderCardConversation(card, row)
    })
  }

  /** 渲染卡片对话：消息 + 该子代理的挂起提问/审批卡（粘底滚动走卡片容器）。 */
  private renderCardConversation(card: CardEl, row: AgentSnapshotRow): void {
    if (this.disposed || !card.convListEl.isConnected) return
    const body = card.bodyEl
    const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 80
    const list = card.convListEl
    const cached = this.cardConv.get(card.id)
    list.replaceChildren()
    if (cached === undefined || cached.state === 'loading') {
      list.appendChild(hintLine('加载对话…'))
    } else if (cached.state === 'fail') {
      list.appendChild(hintLine('对话不可用'))
    } else if (cached.msgs.length === 0) {
      list.appendChild(hintLine('该子代理暂无对话消息'))
    } else {
      for (const msg of cached.msgs) list.appendChild(renderMessage(msg))
    }
    // 挂起交互卡（mux 注册表；waiting 才展示；无注册项时从 action.text 兜底展示）。
    this.renderCardPending(list, row)
    if (stick) body.scrollTop = body.scrollHeight
  }

  private renderCardPending(list: HTMLDivElement, row: AgentSnapshotRow): void {
    const entries = (this.muxPending.get(row.id) ?? []).filter(p => p.kind === 'question' || p.kind === 'approval')
    if (row.waiting === undefined && entries.length === 0) return
    const fallbackQuestions = questionsFromAction(row)
    const faces: PendingFace[] = entries.length > 0
      ? entries
      : fallbackQuestions !== null
        ? [{
            key: `q:fallback:${row.id}`,
            sessionId: row.id,
            kind: 'question' as const,
            questions: fallbackQuestions,
            respond: async () => false, // 无 rpcId 不可应答（mux 连接后会补上）
          }]
        : []
    for (const face of faces) {
      const onAnswered = (): void => {
        // 应答成功后：立即重拉对话流（答案进历史）+ 重排（挂起帧移除）。
        const r = this.snapshot?.rows.find(x => x.id === row.id)
        const c = this.cards.get(row.id)
        if (c !== undefined && r !== undefined) this.refreshCardConversationNow(c, r)
      }
      if (face.kind === 'question') {
        list.appendChild(buildQuestionCard(face, this.questionSel, this.questionInputs, onAnswered))
      } else {
        list.appendChild(buildApprovalCard(face, onAnswered))
      }
    }
  }

  /** 挂起变化后统一重排（用最近快照）。 */
  private reapplyCards(): void {
    if (this.snapshot === null) return
    this.applySnapshot(this.snapshot)
  }

  // ------------------------------------------------------------ 主会话对话流

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

  // ------------------------------------------------------------ 主会话交互卡

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
      const onAnswered = (): void => {
        // 挂起帧已结算：binding 快照变化会驱动重渲染；这里主动拉一次。
        const binding = this.ctx.sessions.binding(this.sessionId)
        if (binding !== undefined) this.renderLeftFromSession(binding.session)
      }
      if (wait.kind === 'question') {
        const face: PendingFace = {
          key: wait.key,
          sessionId: wait.sessionId,
          kind: 'question',
          questions: (wait.payload as { questions?: readonly QuestionItemLike[] }).questions ?? [],
          respond: (result) => wait.respond(result as never).then(r => r.accepted === true),
        }
        this.interactEl.appendChild(buildQuestionCard(face, this.questionSel, this.questionInputs, onAnswered))
      } else if (wait.kind === 'approval') {
        const payload = wait.payload as { toolName?: string; reason?: string; approvalId?: string }
        const face: PendingFace = {
          key: wait.key,
          sessionId: wait.sessionId,
          kind: 'approval',
          toolName: payload.toolName,
          reason: payload.reason,
          approvalId: payload.approvalId,
          respond: (result) => wait.respond(result as never).then(r => r.accepted === true),
        }
        this.interactEl.appendChild(buildApprovalCard(face, onAnswered))
      }
    }
  }
}
