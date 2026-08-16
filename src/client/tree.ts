/**
 * 共享渲染层：快照 → 树的组装、过滤、DOM 渲染、会话跳转。
 *
 * 悬浮窗（index.tsx）与停靠右侧面板（docked.ts）共用同一套树逻辑：
 * 血缘组森林、根活跃窗口筛选、完成态保留/防堆积、四色状态、行渲染、
 * 已读标记、子代理导航跳转。纯函数 + 模块级缓存，不持有 DOM 状态。
 * @module @dsh-external/dsh-agent-board/client/tree
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { AgentBoardSnapshot, AgentSnapshotRow } from '../index.js'

/** 根筛选窗口：最近活跃（working 或刚结束）的顶层会话才显示，更老的隐藏。
 *  10 分钟：闲置项目快速退出看板，避免旧会话堆积。 */
export const ROOT_ACTIVE_WINDOW_MS = 10 * 60_000

/** 完成态保留期：子代理完成后继续保留在板上（父根可见期间可查看），
 *  超时自动消失，避免旧完成节点无限堆积。 */
export const FINISHED_KEEP_MS = 30 * 60_000

/** 每个根下最多保留的完成态子代理行数（running 不限），防海量堆积。 */
export const MAX_FINISHED_PER_ROOT = 12

/** 完成态保留期过滤（可复用）：finished 且超期（30 分钟）剔除，其余保留。
 *  悬浮窗/停靠面板的 renderBoardTree 与「子代理」tab 共用同一筛选规则。 */
export function keepRow(row: AgentSnapshotRow, now: number): boolean {
  return !(row.status === 'finished' && now - row.lastActivity > FINISHED_KEEP_MS)
}

/** 人类可读的时长。 */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return `${Math.floor(ms / 1000)}s`
  if (totalMin < 60) return `${totalMin}m`
  return `${Math.floor(totalMin / 60)}h${totalMin % 60}m`
}

/** localStorage key for viewed (已读) finished session ids. */
const VIEWED_KEY = 'dsh.agentBoard.viewed.v1'
const VIEWED_CAP = 500

const viewedList: string[] = []
const viewedSet = new Set<string>()

export function loadViewed(): void {
  try {
    const raw = localStorage.getItem(VIEWED_KEY)
    if (raw !== null) {
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr)) {
        for (const x of arr) {
          if (typeof x === 'string') {
            viewedSet.add(x)
            viewedList.push(x)
          }
        }
      }
    }
  } catch { /* corrupted state falls back to empty */ }
}

export function markViewed(id: string): void {
  if (viewedSet.has(id)) return
  viewedSet.add(id)
  viewedList.push(id)
  if (viewedList.length > VIEWED_CAP) viewedList.splice(0, viewedList.length - VIEWED_CAP)
  try { localStorage.setItem(VIEWED_KEY, JSON.stringify(viewedList)) } catch { /* storage full: best-effort */ }
}

export function isViewed(id: string): boolean { return viewedSet.has(id) }

/** 一棵渲染树节点：行数据 + 子节点。 */
export interface TreeNode {
  row: AgentSnapshotRow
  children: TreeNode[]
}

/** 把快照组装成森林：每个顶层会话（roots）一棵树，子代理按血缘挂靠。 */
export function buildForest(roots: readonly AgentSnapshotRow[], rows: readonly AgentSnapshotRow[]): TreeNode[] {
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
  // 渲染顺序 = 快照顺序（host 已按创建时间稳定排序）——节点位置不随活动跳动。
  return forest
}

/** 森林节点总数（含所有根）。 */
export function countNodes(forest: TreeNode[]): number {
  return forest.reduce((sum, node) => sum + 1 + node.children.reduce((s, c) => s + countNodes([c]), 0), 0)
}

/** 森林中 running 的节点数。 */
export function countRunning(forest: TreeNode[]): number {
  return forest.reduce((sum, node) => sum + (node.row.status === 'running' ? 1 : 0) + node.children.reduce((s, c) => s + countRunning([c]), 0), 0)
}

/** 节点状态文本（动作优先：工具执行 / 流式输出 > 停滞 > 完成 > 处理中 > 空闲）。 */
export function statusText(row: AgentSnapshotRow, threshold: number): { text: string; stalled: boolean } {
  // 等待人工介入（ask 挂起 / 审批等待）：黄色圈最醒目，优先于一切状态。
  if (row.waiting !== undefined) {
    return { text: '🔔 等你判断', stalled: false }
  }
  if (row.action !== undefined) {
    return row.action.kind === 'tool'
      ? { text: `⚙ ${row.action.text}`, stalled: false }
      : { text: '✍ 输出中…', stalled: false }
  }
  if (row.status === 'finished') return { text: isViewed(row.id) ? '空闲' : '完成', stalled: false }
  if (row.status === 'running') {
    if (row.silentMs > threshold) return { text: `停滞 ${formatDuration(row.silentMs)}`, stalled: true }
    // 无动作且未停滞：同行已有答复节选表达进展，不再显示占位文本。
    return { text: '', stalled: false }
  }
  return { text: '空闲', stalled: false }
}

/** 渲染一个树节点（递归）。根节点（顶层会话）蓝点，当前会话加「当前」标记；
 *  子代理节点显示「子代理<兄弟序号>-<创建名>」。
 *  列结构全行统一（同层严格同列）：[toggle占位10px][圆点][id][节选][状态][当前?]
 *  交互：单击任意行 = 打开会话；展开/折叠只走行首 ▸/▾（仅根且有子节点时出现）。 */
export function renderNode(
  node: TreeNode,
  threshold: number,
  onOpen: (id: string, parentId?: string) => Promise<boolean>,
  opts: { isRoot?: boolean; isCurrent?: boolean; currentId?: string; idx?: number; collapsed?: boolean; onToggle?: () => void } = {},
): HTMLLIElement {
  const { row } = node
  const hasChildren = node.children.length > 0
  const li = document.createElement('li')
  const line = document.createElement('div')
  line.className = 'swd-node'
  if (row.status === 'finished') line.classList.add('swd-finished-line')
  // 单击 = 打开会话；展开/折叠只走行首 ▸/▾。
  line.title = row.lastReply !== undefined
    ? `点击打开会话 ${row.id}\n行首 ▸/▾ 展开/折叠子树\n最新答复：${row.lastReply}`
    : `点击打开会话 ${row.id}\n行首 ▸/▾ 展开/折叠子树`
  line.addEventListener('click', (e) => {
    e.stopPropagation()
    // 立即视觉反馈：主线程忙时跳转渲染可能滞后，高亮先让用户知道点中了。
    line.classList.add('swd-opening')
    void onOpen(row.id, row.parentSession).then(ok => {
      // 跳转彻底失败（会话不在宿主列表等）：红色提示，避免「点击无反应」。
      if (ok !== true) {
        line.classList.remove('swd-opening')
        line.classList.add('swd-open-failed')
        line.title = '打开会话失败（会话可能已不存在），稍后重试'
      }
    })
  })
  const { text, stalled } = statusText(row, threshold)
  const stClass = row.waiting !== undefined ? 'swd-st-waiting'
    : stalled ? 'swd-st-stall'
    : row.status === 'finished' ? (isViewed(row.id) ? 'swd-st-idle' : 'swd-st-finished')
    : row.status === 'running' ? 'swd-st-running'
    : 'swd-st-idle'
  const dot = document.createElement('span')
  dot.className = `swd-dot ${stClass} ${opts.isRoot === true ? 'swd-dot-root' : 'swd-dot-ring'}`
  const idEl = document.createElement('span')
  idEl.className = opts.isRoot === true ? 'swd-id swd-id-root' : 'swd-id'
  // 根节点优先显示会话标题（无标题兜底 id 前 8 位）；子代理优先创建名 label，
  // 无 label 时兜底标题，再兜底 id。
  idEl.textContent = opts.isRoot === true
    ? (row.title ?? row.id.slice(0, 8))
    : (row.label !== undefined
        ? `子代理${opts.idx ?? '?'}-${row.label.slice(0, 24)}`
        : (row.title ?? row.id.slice(0, 8)))
  idEl.title = row.id
  // toggle 列：全行统一占位（10px），保证圆点/id 列对齐；
  // 仅「根且有子节点」时可点（空根/子代理不画假箭头）。
  const toggle = document.createElement('span')
  toggle.className = 'swd-toggle'
  if (opts.isRoot === true && hasChildren) {
    toggle.textContent = opts.collapsed === true ? '▸' : '▾'
    toggle.title = opts.collapsed === true ? '展开子树' : '折叠子树'
    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      opts.onToggle?.()
    })
  } else {
    toggle.textContent = '\u00a0'
    toggle.style.cursor = 'default'
  }
  line.appendChild(toggle)
  line.appendChild(dot)
  line.appendChild(idEl)
  // 答复节选：与状态同一行（名字之后、状态之前），超长省略；有当前动作时
  // 节选已过时（动作即进展），隐藏。
  if (row.action === undefined && row.lastReply !== undefined) {
    const excerptEl = document.createElement('span')
    excerptEl.className = 'swd-excerpt-inline'
    excerptEl.textContent = row.lastReply
    line.appendChild(excerptEl)
  }
  const meta = document.createElement('span')
  meta.className = stalled ? 'swd-stall' : 'swd-meta'
  meta.textContent = text
  if (text !== '') line.appendChild(meta)
  // 「当前」标记：放行尾（不占前列，避免列错位）。
  if (opts.isCurrent === true) {
    const tag = document.createElement('span')
    tag.className = 'swd-tag'
    tag.textContent = '当前'
    line.appendChild(tag)
  }
  li.appendChild(line)
  if (node.children.length > 0 && opts.collapsed !== true) {
    const ul = document.createElement('ul')
    for (const [i, child] of node.children.entries()) {
      // 子代理行同样参与「当前」标记（点开子代理会话后行尾显示 tag，跳转有反馈）。
      ul.appendChild(renderNode(child, threshold, onOpen, { idx: i + 1, isCurrent: child.row.id === opts.currentId }))
    }
    li.appendChild(ul)
  }
  return li
}

/**
 * 一次看板渲染的公共流水线：过滤（完成保留期 / 根活跃窗口 / 防堆积）→
 * 组森林 → 渲染进给定容器 → 更新标题计数。悬浮窗与停靠面板共用。
 * @returns 过滤后的森林（调用方需要展开/折叠状态时可复用）。
 */
export function renderBoardTree(opts: {
  treeEl: HTMLUListElement
  emptyEl: HTMLDivElement
  titleEl?: HTMLElement
  snapshot: AgentBoardSnapshot
  currentId: string | undefined
  collapsedRoots: Set<string>
  expandedRoots: Set<string>
  onOpen: (id: string, parentId?: string) => Promise<boolean>
  /** 用户折叠/展开某根之后回调（surface 借此用最近快照重渲染）。 */
  afterToggle?: () => void
}): TreeNode[] {
  try {
  const { snapshot, currentId } = opts
  const now = snapshot.now
  // 完成项：保留期（30 分钟）内留在板上，超期自动消失；running 恒保留。
  const keptRows = snapshot.rows.filter(row => keepRow(row, now))
  // 根筛选：无对话的空白会话不显示（含当前会话；`hasMessages` 缺省视为显示，
  // 兼容旧 host）+ 当前会话 + 最近活跃窗口内（working 及刚结束的）+ 有活跃子代理的；
  // 其余历史会话不显示（避免整屏都是 idle 树）。
  const keptRoots = snapshot.roots.filter(root => (
    root.hasMessages !== false
    && (root.id === currentId
      || now - root.lastActivity < ROOT_ACTIVE_WINDOW_MS
      || keptRows.some(row => row.parentSession === root.id))
  ))
  const forest = buildForest(keptRoots, keptRows)
  // 完成项防堆积：每个节点下最多保留 MAX_FINISHED_PER_ROOT 条 finished。
  const trimFinished = (node: TreeNode): void => {
    let kept = 0
    node.children = node.children.filter(child => {
      if (child.row.status !== 'finished') return true
      if (kept >= MAX_FINISHED_PER_ROOT) return false
      kept++
      return true
    })
    for (const child of node.children) trimFinished(child)
  }
  for (const root of forest) trimFinished(root)
  opts.treeEl.replaceChildren()
  if (opts.titleEl !== undefined) opts.titleEl.textContent = 'Agent 看板'
  if (forest.length === 0) {
    opts.emptyEl.textContent = '无活跃会话'
    opts.emptyEl.style.display = 'block'
    opts.treeEl.style.display = 'none'
    return forest
  }
  opts.emptyEl.style.display = 'none'
  opts.treeEl.style.display = 'block'
  const total = countNodes(forest)
  const runningCount = countRunning(forest)
  if (opts.titleEl !== undefined) {
    opts.titleEl.textContent = total === 0 ? 'Agent 看板' : `Agent ${runningCount}/${total}`
  }
  for (const root of forest) {
    // 折叠默认值：idle 且没有 running 子代理的根才折叠为单行；
    // 有在跑子代理的根（即使自身 idle 在等结果）默认展开，子代理立即可见。
    const hasRunningChild = (node: TreeNode): boolean =>
      node.children.some(c => c.row.status === 'running' || hasRunningChild(c))
    const defaultCollapsed = root.row.status === 'idle' && !hasRunningChild(root)
    const collapsed = opts.collapsedRoots.has(root.row.id)
      || (defaultCollapsed && !opts.expandedRoots.has(root.row.id))
    opts.treeEl.appendChild(renderNode(root, snapshot.stallThresholdMs, opts.onOpen, {
      isRoot: true,
      isCurrent: root.row.id === currentId,
      currentId,
      collapsed,
      onToggle: () => {
        if (opts.collapsedRoots.has(root.row.id)) {
          opts.collapsedRoots.delete(root.row.id)
          opts.expandedRoots.add(root.row.id)
        } else {
          opts.collapsedRoots.add(root.row.id)
          opts.expandedRoots.delete(root.row.id)
        }
        opts.afterToggle?.()
      },
    }))
  }
  return forest
  } catch (error: unknown) {
    // 渲染异常不静默：树区显示错误行（否则只剩一条边界线，用户无从得知原因）。
    opts.treeEl.replaceChildren()
    opts.emptyEl.textContent = `渲染异常：${error instanceof Error ? error.message : String(error)}`
    opts.emptyEl.style.display = 'block'
    opts.treeEl.style.display = 'none'
    if (opts.titleEl !== undefined) opts.titleEl.textContent = 'Agent 看板（渲染异常）'
    return []
  }
}

/** 生成一次 RPC 调用的 rpcId。`crypto.randomUUID` 仅在 secure context
 *  （HTTPS / localhost）可用；通过 http://LAN-IP 访问 dsh Web UI 时不可用，
 *  退化为时间戳 + 随机串（与 OpenBiliClaw 的兼容写法一致）。 */
export function newRpcId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 看板级 mode 缓存：父会话 → 子代理 → mode（host 投影结果，settle 后稳定；
 *  避免每次点击重复请求 ~400ms 的 /api/subagent.list）。 */
const childModeCache = new Map<string, Map<string, 'continuable' | 'one-shot'>>()

/** 从 host 投影查子代理的 mode（continuable/one-shot），用于构造导航地址。
 *  首次查询整表缓存，后续 0 请求。 */
async function findChildMode(parentId: string, childId: string): Promise<'continuable' | 'one-shot' | undefined> {
  const cached = childModeCache.get(parentId)?.get(childId)
  if (cached !== undefined) return cached
  try {
    const res = await fetch('/api/subagent.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: newRpcId(),
        method: 'subagent.list',
        payload: { parentSessionId: parentId },
      }),
    })
    if (!res.ok) return undefined
    const full = await res.json() as {
      result?: { ok?: boolean; value?: { entries?: readonly { id: string; kind?: string; mode?: string }[] } }
    }
    if (full.result?.ok === true) {
      const map = new Map<string, 'continuable' | 'one-shot'>()
      for (const e of full.result.value?.entries ?? []) {
        if (e.kind === 'child' && (e.mode === 'continuable' || e.mode === 'one-shot')) map.set(e.id, e.mode)
      }
      childModeCache.set(parentId, map)
      return map.get(childId)
    }
  } catch { /* 查询失败继续兜底 */ }
  return undefined
}

/** 跳转到子代理的会话。分层兜底（finished 存档的子代理不在导航地址/列表中）：
 *  ① 已有 catalog 地址 → openSubagent（0 请求）；
 *  ② 子代理快速路径：同步 open 立即跳转（与侧边栏同速），后台补 catalog/地址；
 *  ③ 慢路径兜底：并行拉 catalog + mode 再 openSubagent；
 *  ④ 普通 open，失败则刷新会话列表后重试一次（看板快照是 host 全局的，
 *  目标会话可能不在 client 列表——跨项目冷会话/新会话；侧边栏只列列表内会话所以从不触发）。
 *  @returns 是否跳转成功（false 时调用方应给出可见反馈，避免「点击无反应」）。 */
export async function openBoardSession(ctx: ClientContext, id: string, parentId: string | undefined): Promise<boolean> {
  const tryAddress = (address: { parentSessionId: string; childSessionId: string; mode: 'continuable' | 'one-shot' }): boolean => {
    try {
      ctx.sessions.openSubagent(address)
      return true
    } catch { return false }
  }
  // ① 已有导航地址
  const known = ctx.sessions.subagentAddress(id)
  if (known !== undefined && tryAddress(known)) return true
  // ② 子代理快速路径：先同步打开（立即跳转），后台补 catalog/地址
  if (parentId !== undefined) {
    let opened = false
    try {
      ctx.sessions.open(id)
      opened = true
    } catch { /* 不在全局列表，走慢路径 */ }
    if (opened) {
      void (async () => {
        try {
          await ctx.sessions.refreshSubagents(parentId)
          // 用户已切走则不抢回 current
          if (ctx.sessions.list.getSnapshot().current !== id) return
          const mode = await findChildMode(parentId, id)
          if (mode !== undefined) tryAddress({ parentSessionId: parentId, childSessionId: id, mode })
        } catch { /* 后台补地址失败不影响已完成的跳转 */ }
      })()
      return true
    }
    // ③ 慢路径兜底：并行拉 catalog + mode
    await Promise.all([
      ctx.sessions.refreshSubagents(parentId).catch(() => undefined),
      findChildMode(parentId, id),
    ])
    const mode = await findChildMode(parentId, id) // 缓存命中，0 请求
    if (mode !== undefined && tryAddress({ parentSessionId: parentId, childSessionId: id, mode })) return true
  }
  // ④ 普通 open（顶层会话；子代理会话不在列表时可能抛错）
  try {
    ctx.sessions.open(id)
    return true
  } catch {
    // 补救：刷新会话列表（host 全局列表，含跨项目/新会话）后重试一次。
    try {
      await (ctx.sessions as unknown as { refresh(): Promise<void> }).refresh()
      ctx.sessions.open(id)
      return true
    } catch { return false } // 仍失败：调用方给出可见反馈
  }
}
