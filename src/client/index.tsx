/**
 * @dsh-external/dsh-subagent-watchdog — 浏览器半区：常驻 Agent 看板。
 *
 * A persistent always-on-top floating window (top-right by default) that
 * renders the live agent tree — the current session as root, its subagents
 * branching down — with per-node status (running / idle / stalled highlight),
 * silent duration, latest reply excerpt, and last activity. Polls
 * `GET /api/subagent-watchdog/agents` every {@link POLL_MS}; the poll pauses
 * while the tab is hidden.
 *
 * Interactions (same pattern as dsh-sysmon's widget): drag the title bar to
 * move (position persisted to localStorage), click the title to collapse to a
 * one-line strip, click × to hide (a summon button reappears bottom-right).
 * The sidebar footer action toggles the window's visibility via a custom
 * event. All rendering is plain DOM — no store, no css modules.
 *
 * Failure policy: transport errors render an "offline" hint and keep the poll
 * alive; nothing throws (the web shell fails boot on apply throw).
 * @module @dsh-external/dsh-subagent-watchdog/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-slots SlotMap merge table (incl. ui-sidebar's
// 'sidebar.footer.action' declaration) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useEffect, useState } from 'react'
import type { AgentSnapshotRow, WatchdogSnapshot } from '../index.js'

/** Poll interval (ms) while the tab is visible. */
const POLL_MS = 5000

/** localStorage key for the widget position + visibility. */
const LS_KEY = 'dsh.subagentWatchdog.v1'

/** Toggle event fired by the sidebar footer action. */
const TOGGLE_EVENT = 'dsh.subagentWatchdog.toggle'

/** Default widget position (px from the viewport top/right edges). */
const DEFAULT_TOP = 64
const DEFAULT_RIGHT = 16

/** Persisted widget placement. */
interface WidgetState {
  top: number
  right: number
  visible: boolean
  collapsed: boolean
}

function loadState(): WidgetState {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<WidgetState>
      return {
        top: typeof parsed.top === 'number' ? parsed.top : DEFAULT_TOP,
        right: typeof parsed.right === 'number' ? parsed.right : DEFAULT_RIGHT,
        visible: parsed.visible !== false,
        collapsed: parsed.collapsed === true,
      }
    }
  } catch { /* corrupted state falls back to defaults */ }
  return { top: DEFAULT_TOP, right: DEFAULT_RIGHT, visible: true, collapsed: false }
}

function saveState(state: WidgetState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
  } catch { /* storage full/blocked: position persistence is best-effort */ }
}

/** Widget + tree styles, injected once into <head>. */
const WIDGET_CSS = `
.swd-widget {
  position: fixed;
  z-index: 2147483647;
  width: 300px;
  max-height: 55vh;
  display: flex;
  flex-direction: column;
  font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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
  font-size: 11px;
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
  font-size: 13px;
  line-height: 1;
  padding: 0 4px;
}
.swd-close:hover { color: #fff; }
.swd-body { overflow-y: auto; padding: 6px 8px; }
.swd-tree { margin: 0; padding: 0; list-style: none; }
.swd-tree ul { margin: 0; padding: 0 0 0 14px; list-style: none; border-left: 1px dashed rgba(154, 208, 255, 0.25); }
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
.swd-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: none; transform: translateY(-0.5px); }
.swd-dot-running { background: #4ade80; }
.swd-dot-idle { background: #6b7280; }
.swd-dot-root { background: #60a5fa; box-shadow: 0 0 5px rgba(96, 165, 250, 0.8); }
.swd-tag {
  color: #0f172a;
  background: #60a5fa;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  line-height: 1.4;
  flex: none;
}
.swd-id { color: #d7dde3; }
.swd-id-root { color: #9ad0ff; font-weight: 700; }
.swd-meta { color: #9aa0a6; margin-left: auto; padding-left: 8px; }
.swd-stall { color: #f87171; font-weight: 700; margin-left: auto; padding-left: 8px; }
.swd-offline { color: #fbbf24; text-align: center; padding: 4px 0; }
.swd-empty { color: #9aa0a6; text-align: center; padding: 4px 0; }
.swd-excerpt {
  color: #8b93a1;
  font-size: 10px;
  line-height: 1.4;
  padding: 0 0 2px 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.swd-summon {
  position: fixed;
  right: 16px;
  bottom: 20px;
  z-index: 2147483647;
  cursor: pointer;
  font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.swd-action:hover { color: #e6e6e6; background: rgba(255, 255, 255, 0.06); border-radius: 6px; }
`

/** 人类可读的时长。 */
function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return `${Math.floor(ms / 1000)}s`
  if (totalMin < 60) return `${totalMin}m`
  return `${Math.floor(totalMin / 60)}h${totalMin % 60}m`
}

/** 一棵渲染树节点：行数据 + 子节点。 */
interface TreeNode {
  row: AgentSnapshotRow
  children: TreeNode[]
}

/** 把快照组装成森林：每个顶层会话（roots）一棵树，子代理按血缘挂靠。 */
function buildForest(roots: readonly AgentSnapshotRow[], rows: readonly AgentSnapshotRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const row of rows) byId.set(row.id, { row, children: [] })
  const forest = roots.map(row => ({ row, children: [] as TreeNode[] }))
  const attach = (parent: TreeNode): void => {
    for (const node of byId.values()) {
      if (node.row.parentSession === parent.row.id) {
        parent.children.push(node)
        attach(node)
      }
    }
  }
  for (const root of forest) attach(root)
  // 子节点按静默时长升序（活跃的在前）。
  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => a.row.silentMs - b.row.silentMs)
    for (const n of nodes) sortNodes(n.children)
  }
  for (const root of forest) sortNodes(root.children)
  return forest
}

/** 森林节点总数（含所有根）。 */
function countNodes(forest: TreeNode[]): number {
  return forest.reduce((sum, node) => sum + 1 + node.children.reduce((s, c) => s + countNodes([c]), 0), 0)
}

/** 森林中 running 的节点数。 */
function countRunning(forest: TreeNode[]): number {
  return forest.reduce((sum, node) => sum + (node.row.status === 'running' ? 1 : 0) + node.children.reduce((s, c) => s + countRunning([c]), 0), 0)
}

/** 节点状态文本（动作优先：工具执行 / 流式输出 > 停滞 > 处理中 > 空闲）。 */
function statusText(row: AgentSnapshotRow, threshold: number): { text: string; stalled: boolean } {
  if (row.action !== undefined) {
    return row.action.kind === 'tool'
      ? { text: `⚙ ${row.action.text}`, stalled: false }
      : { text: '✍ 输出中…', stalled: false }
  }
  if (row.status === 'running') {
    if (row.silentMs > threshold) return { text: `停滞 ${formatDuration(row.silentMs)}`, stalled: true }
    return { text: '处理中…', stalled: false }
  }
  return { text: '空闲', stalled: false }
}

/** 渲染一个树节点（递归）。根节点（顶层会话）蓝色点，当前会话加「当前」标记；
 *  子代理节点显示「子代理<兄弟序号>-<创建名>」。 */
function renderNode(
  node: TreeNode,
  threshold: number,
  onOpen: (id: string) => void,
  opts: { isRoot?: boolean; isCurrent?: boolean; idx?: number } = {},
): HTMLLIElement {
  const { row } = node
  const li = document.createElement('li')
  const line = document.createElement('div')
  line.className = 'swd-node'
  line.title = row.lastReply !== undefined
    ? `点击打开会话 ${row.id}\n最新答复：${row.lastReply}`
    : `点击打开会话 ${row.id}`
  line.addEventListener('click', (e) => {
    e.stopPropagation()
    onOpen(row.id)
  })
  const dot = document.createElement('span')
  dot.className = opts.isRoot === true
    ? 'swd-dot swd-dot-root'
    : `swd-dot ${row.status === 'running' ? 'swd-dot-running' : 'swd-dot-idle'}`
  const idEl = document.createElement('span')
  idEl.className = opts.isRoot === true ? 'swd-id swd-id-root' : 'swd-id'
  idEl.textContent = opts.isRoot === true || row.label === undefined
    ? row.id.slice(0, 8)
    : `子代理${opts.idx ?? '?'}-${row.label.slice(0, 24)}`
  idEl.title = row.id
  line.appendChild(dot)
  if (opts.isCurrent === true) {
    const tag = document.createElement('span')
    tag.className = 'swd-tag'
    tag.textContent = '当前'
    line.appendChild(tag)
  }
  line.appendChild(idEl)
  const { text, stalled } = statusText(row, threshold)
  const meta = document.createElement('span')
  meta.className = stalled ? 'swd-stall' : 'swd-meta'
  meta.textContent = text
  line.appendChild(meta)
  li.appendChild(line)
  // 有当前动作时节选已过时（动作即进展），隐藏；空闲/停滞时显示最近产出。
  if (row.action === undefined && row.lastReply !== undefined) {
    const excerptEl = document.createElement('div')
    excerptEl.className = 'swd-excerpt'
    excerptEl.textContent = row.lastReply
    li.appendChild(excerptEl)
  }
  if (node.children.length > 0) {
    const ul = document.createElement('ul')
    for (const [i, child] of node.children.entries()) {
      ul.appendChild(renderNode(child, threshold, onOpen, { idx: i + 1 }))
    }
    li.appendChild(ul)
  }
  return li
}

/** 跳转到子代理的会话（优先走 catalog 子代理地址，否则普通 open）。 */
function openSession(ctx: ClientContext, id: string): void {
  const addr = ctx.sessions.subagentAddress(id)
  if (addr !== undefined) {
    ctx.sessions.openSubagent(addr)
    return
  }
  ctx.sessions.open(id)
}

/** 常驻悬浮窗：树形展示子代理层级 + 状态。 */
class WatchdogWidget {
  private readonly ctx: ClientContext
  private readonly state: WidgetState
  private readonly root: HTMLDivElement
  private readonly titleBarEl: HTMLDivElement
  private readonly titleTextEl: HTMLSpanElement
  private readonly bodyEl: HTMLDivElement
  private readonly treeEl: HTMLUListElement
  private readonly offlineEl: HTMLDivElement
  private timer: number | undefined
  private fetching = false
  private dragging = false
  private dragMoved = false
  private suppressClick = false
  private dragPointerId = 0
  private dragStartX = 0
  private dragStartY = 0
  private dragStartTop = 0
  private dragStartRight = 0
  private summonEl: HTMLButtonElement | null = null
  private visibilityCleanup: (() => void) | null = null

  constructor(ctx: ClientContext) {
    this.ctx = ctx
    this.state = loadState()
    this.root = document.createElement('div')
    this.root.className = 'swd-widget'
    this.root.style.top = `${this.state.top}px`
    this.root.style.right = `${this.state.right}px`

    this.titleTextEl = document.createElement('span')
    this.titleTextEl.className = 'swd-title-left'
    this.titleTextEl.textContent = 'Agent 看板'

    const closeBtn = document.createElement('span')
    closeBtn.className = 'swd-close'
    closeBtn.textContent = '×'
    closeBtn.title = '隐藏悬浮窗'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.hide()
    })

    this.titleBarEl = document.createElement('div')
    this.titleBarEl.className = 'swd-title'
    this.titleBarEl.title = 'Agent 看板（拖动移动 · 点击折叠/展开）'
    this.titleBarEl.appendChild(this.titleTextEl)
    this.titleBarEl.appendChild(closeBtn)
    this.titleBarEl.addEventListener('pointerdown', (e) => this.beginDrag(e))
    this.titleBarEl.addEventListener('click', (e) => {
      if (e.target === closeBtn) return
      if (this.suppressClick) {
        this.suppressClick = false
        return
      }
      this.state.collapsed = !this.state.collapsed
      saveState(this.state)
      this.renderCollapse()
    })

    this.treeEl = document.createElement('ul')
    this.treeEl.className = 'swd-tree'
    this.offlineEl = document.createElement('div')
    this.offlineEl.className = 'swd-offline'
    this.offlineEl.textContent = '离线（宿主路由不可达）'
    this.offlineEl.style.display = 'none'

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'swd-body'
    this.bodyEl.appendChild(this.offlineEl)
    this.bodyEl.appendChild(this.treeEl)

    this.root.appendChild(this.titleBarEl)
    this.root.appendChild(this.bodyEl)

    document.addEventListener(TOGGLE_EVENT, () => {
      if (this.state.visible) this.hide()
      else this.show()
    })
  }

  private renderCollapse(): void {
    this.bodyEl.style.display = this.state.collapsed ? 'none' : 'block'
  }

  /** 挂载进 DOM 并开始轮询（仅可见时轮询）。 */
  mount(): void {
    ensureStyles()
    if (this.state.visible) document.body.appendChild(this.root)
    this.renderCollapse()
    this.renderSummon()
    this.start()
    this.poll()
  }

  dispose(): void {
    this.stop()
    this.root.remove()
    if (this.summonEl !== null) {
      this.summonEl.remove()
      this.summonEl = null
    }
    if (this.visibilityCleanup !== null) {
      this.visibilityCleanup()
      this.visibilityCleanup = null
    }
  }

  private hide(): void {
    this.state.visible = false
    saveState(this.state)
    this.root.remove()
    this.renderSummon()
    this.stop()
  }

  private show(): void {
    this.state.visible = true
    saveState(this.state)
    document.body.appendChild(this.root)
    this.renderCollapse()
    this.renderSummon()
    this.start()
    this.poll()
  }

  private renderSummon(): void {
    if (this.state.visible) {
      this.summonEl?.remove()
      this.summonEl = null
      return
    }
    if (this.summonEl !== null) return
    const btn = document.createElement('button')
    btn.className = 'swd-summon'
    btn.textContent = '◉ Agent 看板'
    btn.addEventListener('click', () => this.show())
    document.body.appendChild(btn)
    this.summonEl = btn
  }

  private beginDrag(e: PointerEvent): void {
    if (e.target instanceof Element && e.target.classList.contains('swd-close')) return
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
    if (this.fetching || document.hidden) return
    this.fetching = true
    void fetch('/api/subagent-watchdog/agents')
      .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.json() as Promise<WatchdogSnapshot> })
      .then(snapshot => this.render(snapshot))
      .catch(() => {
        this.offlineEl.style.display = 'block'
        this.treeEl.replaceChildren()
        this.titleTextEl.textContent = 'Agent 看板（离线）'
      })
      .finally(() => { this.fetching = false })
  }

  private render(snapshot: WatchdogSnapshot): void {
    this.offlineEl.style.display = 'none'
    const currentId = this.ctx.sessions.list.getSnapshot().current
    const forest = buildForest(snapshot.roots, snapshot.rows)
    this.treeEl.replaceChildren()
    if (forest.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'swd-empty'
      empty.textContent = '无活跃会话'
      this.treeEl.appendChild(empty)
      this.titleTextEl.textContent = 'Agent 看板'
      return
    }
    const total = countNodes(forest)
    const runningCount = countRunning(forest)
    this.titleTextEl.textContent = total === 0 ? 'Agent 看板' : `Agent ${runningCount}/${total}`
    for (const root of forest) {
      this.treeEl.appendChild(renderNode(root, snapshot.stallThresholdMs, id => openSession(this.ctx, id), {
        isRoot: true,
        isCurrent: root.row.id === currentId,
      }))
    }
  }
}

let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = WIDGET_CSS
  document.head.appendChild(style)
}

/** 侧边栏 foot 触发器（rail 时仅图标，wide 时图标 + 文字）。 */
function WatchdogAction(props: { wide: boolean }) {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const onToggle = (): void => setActive(v => !v)
    document.addEventListener(TOGGLE_EVENT, onToggle)
    return () => document.removeEventListener(TOGGLE_EVENT, onToggle)
  }, [])
  return (
    <button
      className="swd-action"
      title="Agent 看板"
      style={active ? { color: '#9ad0ff' } : undefined}
      onClick={() => document.dispatchEvent(new Event(TOGGLE_EVENT))}
    >
      <span>◉</span>
      {props.wide && <span>Agent 看板</span>}
    </button>
  )
}

/**
 * Client plugin body: mount the persistent widget and register the sidebar
 * footer action.
 * @param ctx - client root context (slots + cordis base).
 */
export const inject = ['slots', 'sessions'] as const

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-subagent-watchdog',
    order: 100,
    inject: () => ({}),
  }, WatchdogAction), 'watchdog: footer action')
  ctx.effect(() => {
    const widget = new WatchdogWidget(ctx)
    widget.mount()
    return () => widget.dispose()
  }, 'watchdog: floating window')
}
