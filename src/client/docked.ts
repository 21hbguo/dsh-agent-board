/**
 * 停靠右侧面板：Agent 看板的常驻右栏形态。
 *
 * 布局方案与 AionUi 风格文件插件（dsh-client-ui-aionui-panel）一致：
 * 在 web shell 的网格 frame（`[data-dsh-frame]`，inline grid-template-columns
 * 三列：sidebar / center / details）末尾追加一列轨道，把中心列挤窄而不是
 * 悬浮遮挡；同步 shell 的 inline 网格（MutationObserver），左侧拖拽把手调宽
 * （220–520px，双击复位 300px），折叠为 0 宽但保持挂载，折叠时右侧出现
 * 浮动的展开按钮。与 aionui 面板并存时识别其 5 轨写并保留其中间轨道。
 *
 * 面板内容（树形看板）与悬浮窗共用 tree.ts 渲染管线，只是容器不同。
 * @module @dsh-external/dsh-agent-board/client/docked
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { AgentBoardSnapshot } from '../index.js'
import { DOCKED_DEFAULT_WIDTH, DOCKED_MAX_WIDTH, DOCKED_MIN_WIDTH, type BoardState } from './state.js'
import { renderBoardTree } from './tree.js'

/** 停靠面板与 App 之间的动作契约（由 index.tsx 的 AgentBoardApp 提供）。 */
export interface DockedBoardActions {
  /** 打开一个会话（跳转）。 */
  onOpen: (id: string, parentId?: string) => Promise<boolean>
  /** 在锚点元素附近弹出形态菜单（悬浮窗 / 停靠 / 并存 / 隐藏）。 */
  openModeMenu: (anchor: HTMLElement, onClose: () => void) => void
  /** 隐藏整个看板（× 按钮）。 */
  onHide: () => void
  /** 折叠状态变化（标题点击切换）。 */
  onCollapsedChange: (collapsed: boolean) => void
  /** 宽度实时变化（拖拽中，不落盘）。 */
  onWidthChange: (width: number) => void
  /** 宽度拖拽结束（落盘）。 */
  onWidthCommit: () => void
  /** 从折叠态展开。 */
  onExpand: () => void
}

/**
 * Locate the frame grid element the docked column appends into. The web-ui
 * aggregate's compat shim stamps `data-dsh-frame` onto the grid; without the
 * shim, fall back to the rc.6-native structure: the frame grid is the parent
 * of the sidebar column.
 */
function findFrame(): HTMLElement | null {
  const stamped = document.querySelector<HTMLElement>('[data-dsh-frame]')
  if (stamped !== null) return stamped
  return document.querySelector<HTMLElement>('[class*="sidebarCol"]')?.parentElement ?? null
}

/**
 * Parse an inline grid-template-columns string into its tracks. Handles
 * "minmax(0, 1fr)" (spaces inside parens must not split). Empty on failure.
 */
export function parseGridTracks(input: string): string[] {
  const tracks: string[] = []
  let depth = 0
  let current = ''
  for (const char of input) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ' ' && depth === 0) {
      if (current !== '') {
        tracks.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') tracks.push(current)
  return tracks
}

/**
 * 布局控制器：frame 发现 → 把面板列追加进 frame → 镜像 shell 网格。
 *
 * 网格状态机（与 aionui 面板同思想）：
 *  - 3 轨  = shell 自己的写（sidebar/center/details）→ 记住并追加我们的轨道；
 *  - 5 轨  = shell + aionui 面板（preview/explorer）→ 保留其中间 2 轨再追加；
 *  - 4/6 轨 = 我们自己的写（含/不含 aionui 中间轨）→ 幂等核对（lastApplied 防回环）；
 *  - 其他  = 不可信状态，等下一次 shell 写（绝不猜测 shell 轨道）。
 */
class DockedLayout {
  private frame: HTMLElement | null = null
  private shellTracks: string[] = []
  private extraTracks: string[] = []
  private lastApplied = ''
  private frameWidth = 0
  private col: HTMLDivElement | null = null
  private handle: HTMLDivElement | null = null
  private expandBtn: HTMLButtonElement | null = null
  private waitObserver: MutationObserver | null = null
  private styleObserver: MutationObserver | null = null
  private sizeObserver: ResizeObserver | null = null
  private dragging = false
  private dragPointerId = 0
  private dragStartX = 0
  private dragStartWidth = 0
  private dragRaf: number | null = null
  private dragLatestWidth = 0
  private instantTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: {
    getWidth(): number
    isCollapsed(): boolean
    isVisible(): boolean
    onWidthChange(width: number): void
    onWidthCommit(): void
    onExpand(): void
  }) {}

  /** 挂载：等待 frame 出现后附加列与观察器。 @param col 面板列（由面板创建）。 */
  mount(col: HTMLDivElement): void {
    const tryAttach = (): void => {
      // frame 被 React 重建（会话切换等导致 shell 重挂布局）后，列与观察器
      // 都挂在旧 frame 上随之失效——检测到 frame 脱离 DOM / 列被移出即重挂。
      if (this.frame !== null) {
        if (!document.contains(this.frame) || (this.col !== null && !this.col.isConnected)) {
          this.detach()
        }
      }
      if (this.frame === null) {
        const frame = findFrame()
        if (frame === null) return
        this.attach(frame, this.col ?? col)
      }
    }
    this.waitObserver = new MutationObserver(() => { tryAttach() })
    this.waitObserver.observe(document.body, { childList: true, subtree: true })
    tryAttach()
  }

  /** 拆除挂载（观察器/把手/按钮/网格恢复），保留面板列 DOM 供重挂。 */
  private detach(): void {
    this.styleObserver?.disconnect()
    this.styleObserver = null
    this.sizeObserver?.disconnect()
    this.sizeObserver = null
    this.handle?.remove()
    this.handle = null
    this.expandBtn?.remove()
    this.expandBtn = null
    if (this.frame !== null) {
      // 按「当前实际网格」去掉我们的末尾轨道恢复——不覆盖 React 刚写的新宽度。
      const tracks = parseGridTracks(this.frame.style.gridTemplateColumns)
      if (tracks.length === 4) {
        this.frame.style.gridTemplateColumns = tracks.slice(0, 3).join(' ')
      } else if (tracks.length === 6) {
        this.frame.style.gridTemplateColumns = tracks.slice(0, 5).join(' ')
      }
    }
    this.frame = null
    this.shellTracks = []
    this.extraTracks = []
    this.lastApplied = ''
    this.frameWidth = 0
    if (this.instantTimer !== undefined) {
      clearTimeout(this.instantTimer)
      this.instantTimer = undefined
    }
    if (this.dragRaf !== null) {
      cancelAnimationFrame(this.dragRaf)
      this.dragRaf = null
    }
    this.dragging = false
  }

  private attach(frame: HTMLElement, col: HTMLDivElement): void {
    this.frame = frame
    this.col = col
    frame.appendChild(col)

    const handle = document.createElement('div')
    handle.className = 'swd-dock-handle'
    handle.title = '拖拽调整宽度 · 双击复位 300px'
    handle.addEventListener('pointerdown', (e) => this.beginDrag(e))
    handle.addEventListener('dblclick', () => {
      this.deps.onWidthChange(DOCKED_DEFAULT_WIDTH)
      this.deps.onWidthCommit()
      this.applyGrid()
    })
    frame.appendChild(handle)
    this.handle = handle

    const expandBtn = document.createElement('button')
    expandBtn.className = 'swd-dock-expand'
    expandBtn.type = 'button'
    expandBtn.title = '展开 Agent 看板'
    expandBtn.textContent = '◉'
    expandBtn.addEventListener('click', () => this.deps.onExpand())
    document.body.appendChild(expandBtn)
    this.expandBtn = expandBtn

    // 镜像 shell 的 inline 网格：任何 shell 写都重新追加我们的轨道。
    const syncGrid = (): void => {
      const el = this.frame
      if (el === null) return
      const inline = el.style.gridTemplateColumns
      if (inline === '') return
      const tracks = parseGridTracks(inline)
      if (tracks.length === 3) {
        this.shellTracks = tracks
        this.extraTracks = []
        this.applyGrid()
        return
      }
      if (tracks.length === 5) {
        // shell + aionui 面板的写：记住前 3 轨 + 中间 2 轨，再追加我们的。
        this.shellTracks = tracks.slice(0, 3)
        this.extraTracks = tracks.slice(3)
        this.applyGrid()
        return
      }
      if (tracks.length === 4 || tracks.length === 6) {
        // 我们自己的写（含/不含中间轨）：幂等核对（lastApplied 防回环）。
        this.shellTracks = tracks.slice(0, 3)
        this.extraTracks = tracks.length === 6 ? tracks.slice(3, 5) : []
        this.applyGrid()
        return
      }
      // 其他长度：不可信，等下一次 shell 写。
    }
    this.styleObserver = new MutationObserver(syncGrid)
    this.styleObserver.observe(frame, { attributes: true, attributeFilter: ['style'] })

    const measure = (): void => {
      if (this.frame === null) return
      this.frameWidth = this.frame.getBoundingClientRect().width
      this.applyGrid()
    }
    this.sizeObserver = new ResizeObserver(() => { measure() })
    this.sizeObserver.observe(frame)

    // 初始同步：读 shell 已应用的网格。优先 inline（React 写的），
    // inline 尚未写入时回退 computed（CSS 类定义的 grid 同样可解析）——
    // 否则 shellTracks 为空会让 applyGrid 静默失效：列落进 grid 隐式轨道，
    // 宽度失控（隐藏/折叠/显示全部失灵，面板「关不掉」或「出不来」）。
    const initial = frame.style.gridTemplateColumns || getComputedStyle(frame).gridTemplateColumns
    if (initial !== '') {
      const tracks = parseGridTracks(initial)
      if (tracks.length === 3) {
        this.shellTracks = tracks
      } else if (tracks.length === 5) {
        this.shellTracks = tracks.slice(0, 3)
        this.extraTracks = tracks.slice(3)
      } else if (tracks.length === 4 || tracks.length === 6) {
        // frame 可能已带我们上一轮的写：取前 3 轨为 shell 轨道。
        this.shellTracks = tracks.slice(0, 3)
        this.extraTracks = tracks.length === 6 ? tracks.slice(3, 5) : []
      }
    }
    measure()
    this.applyGrid()
    // 网格尚未就绪（inline 与 computed 都为空）：延迟重读一次，
    // 避免 shellTracks 永远为空导致面板宽度失控。
    if (this.shellTracks.length !== 3) {
      window.setTimeout(() => {
          if (this.frame === null || this.shellTracks.length === 3) return
        const now = this.frame.style.gridTemplateColumns || getComputedStyle(this.frame).gridTemplateColumns
        if (now === '') return
        const tracks = parseGridTracks(now)
        if (tracks.length === 3) {
          this.shellTracks = tracks
        } else if (tracks.length === 5) {
          this.shellTracks = tracks.slice(0, 3)
          this.extraTracks = tracks.slice(3)
        }
        this.applyGrid()
      }, 500)
    }
  }

  /** 重写 frame 网格并定位把手/展开按钮（public：App 状态变化时直接调用）。 */
  applyGrid(): void {
    const frame = this.frame
    if (frame === null) return
    if (this.shellTracks.length !== 3) return
    const width = this.deps.isVisible() && !this.deps.isCollapsed() ? Math.round(this.deps.getWidth()) : 0
    const grid = [...this.shellTracks, ...this.extraTracks, `${width}px`].join(' ')
    // 幂等判定与 DOM 当前值比较（而非上次计算值）：React 每次渲染会把
    // 我们的尾轨覆盖回 shell 轨道，此时必须写回——否则列落进 grid 隐式
    // 轨道，宽度失控（隐藏/折叠/显示全部失灵）。
    if (grid === frame.style.gridTemplateColumns) return
    // 我们自己改轨道（拖拽/折叠/展开）时禁用 shell 的 grid 过渡，
    // 否则 300ms 缓动让把手/内容跟不上指针（aionui 同款处理）。
    // 拖拽期间类由 beginDrag 持续持有（onDragEnd 移除），这里只处理单次操作。
    if (!this.dragging) this.instant(frame)
    this.lastApplied = grid
    frame.style.gridTemplateColumns = grid
    if (this.col !== null) {
      this.col.style.visibility = width > 0 ? 'visible' : 'hidden'
    }
    const fw = this.frameWidth > 0 ? this.frameWidth : frame.getBoundingClientRect().width
    if (this.handle !== null) {
      // 把手在面板左边缘：left = 帧宽 - 面板宽，拖拽时跟随指针（见 onDragMove）。
      this.handle.style.left = `${Math.round(fw - width)}px`
      this.handle.style.display = width > 0 ? 'block' : 'none'
    }
    if (this.expandBtn !== null) {
      // 仅「可见且折叠为 0 宽」时出现；整体隐藏时由召唤按钮接管。
      this.expandBtn.style.display = this.deps.isVisible() && this.deps.isCollapsed() ? 'flex' : 'none'
    }
  }

  /** 本次写轨道的瞬间禁用 grid 过渡（一帧后恢复）。 */
  private instant(frame: HTMLElement): void {
    frame.classList.add('swd-instant-grid')
    if (this.instantTimer !== undefined) clearTimeout(this.instantTimer)
    this.instantTimer = setTimeout(() => {
      this.instantTimer = undefined
      frame.classList.remove('swd-instant-grid')
    }, 0)
  }

  private beginDrag(e: PointerEvent): void {
    this.dragging = true
    this.dragPointerId = e.pointerId
    this.dragStartX = e.clientX
    this.dragStartWidth = this.deps.getWidth()
    // 整个拖拽期间禁用 grid 过渡：逐帧写轨道才不会触发 300ms 缓动追指针。
    this.frame?.classList.add('swd-instant-grid')
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch { /* capture is best-effort */ }
    window.addEventListener('pointermove', this.onDragMove)
    window.addEventListener('pointerup', this.onDragEnd, { once: true })
    window.addEventListener('pointercancel', this.onDragEnd, { once: true })
  }

  private readonly onDragMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return
    // 边缘跟随指针：把手在面板左边缘，往左拖变宽、往右拖变窄，
    // 把手（left = 帧宽 - 面板宽）始终停留在指针下。
    const width = Math.min(DOCKED_MAX_WIDTH, Math.max(DOCKED_MIN_WIDTH, this.dragStartWidth + (this.dragStartX - e.clientX)))
    // rAF 节流：高频 pointermove 合并为每帧一次写，避免一帧内多次整帧 reflow。
    this.dragLatestWidth = width
    if (this.dragRaf !== null) return
    this.dragRaf = requestAnimationFrame(() => {
      this.dragRaf = null
      this.deps.onWidthChange(this.dragLatestWidth)
      this.applyGrid()
    })
  }

  private readonly onDragEnd = (): void => {
    if (!this.dragging) return
    this.dragging = false
    if (this.dragRaf !== null) {
      cancelAnimationFrame(this.dragRaf)
      this.dragRaf = null
    }
    // 收尾落定：确保最后一次宽度生效并持久化。
    this.deps.onWidthChange(this.dragLatestWidth)
    this.applyGrid()
    window.removeEventListener('pointermove', this.onDragMove)
    this.frame?.classList.remove('swd-instant-grid')
    this.deps.onWidthCommit()
  }

  /** 卸载即净：断开观察器、移除把手/按钮，把网格恢复为 shell（+中间轨）。 */
  dispose(): void {
    this.waitObserver?.disconnect()
    this.waitObserver = null
    this.detach()
  }
}

/**
 * 停靠面板：列容器（header + body）+ 布局控制器。树渲染走 tree.ts 公共管线。
 * 状态对象由 App 在构造后 bind 进来（App 就地修改，读引用即最新）。
 */
export class DockedAgentBoard {
  private state: BoardState | null = null
  private readonly layout: DockedLayout
  private col: HTMLDivElement | null = null
  private titleEl: HTMLSpanElement | null = null
  private treeEl: HTMLUListElement | null = null
  private emptyEl: HTMLDivElement | null = null
  private offlineEl: HTMLDivElement | null = null
  private lastSnapshot: AgentBoardSnapshot | null = null
  /** 用户手动折叠/展开的根（与悬浮窗各自独立记忆）。 */
  private readonly collapsedRoots = new Set<string>()
  private readonly expandedRoots = new Set<string>()
  /** 布局可见性（visible=false 时整列收为 0 宽）。 */
  private visible = false

  constructor(
    private readonly ctx: ClientContext,
    private readonly actions: DockedBoardActions,
  ) {
    this.layout = new DockedLayout({
      getWidth: () => this.state?.dockedWidth ?? DOCKED_DEFAULT_WIDTH,
      isCollapsed: () => this.state?.dockedCollapsed ?? false,
      isVisible: () => this.visible,
      onWidthChange: (width) => this.actions.onWidthChange(width),
      onWidthCommit: () => this.actions.onWidthCommit(),
      onExpand: () => this.actions.onExpand(),
    })
  }

  /** 绑定 App 的状态对象（就地修改，无需再同步）。 */
  bindState(state: BoardState): void {
    this.state = state
  }

  /** 挂载：建列 DOM + 布局控制器（布局就绪后 applyGrid 生效）。 */
  mount(): void {
    const col = document.createElement('div')
    col.className = 'swd-dock-col'

    const header = document.createElement('div')
    header.className = 'swd-dock-header'
    header.title = 'Agent 看板（点击标题折叠/展开）'

    const titleEl = document.createElement('span')
    titleEl.className = 'swd-dock-title'
    titleEl.textContent = 'Agent 看板'
    titleEl.addEventListener('click', () => {
      if (this.state !== null) this.actions.onCollapsedChange(!this.state.dockedCollapsed)
    })
    header.appendChild(titleEl)
    this.titleEl = titleEl

    const modeBtn = document.createElement('button')
    modeBtn.type = 'button'
    modeBtn.className = 'swd-dock-mode'
    modeBtn.textContent = '▦'
    modeBtn.title = '显示形态：悬浮窗 / 停靠右侧 / 并存 / 隐藏'
    modeBtn.addEventListener('click', () => this.actions.openModeMenu(modeBtn, () => { /* 菜单自行管理关闭 */ }))
    header.appendChild(modeBtn)

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'swd-dock-close'
    closeBtn.textContent = '×'
    closeBtn.title = '隐藏看板'
    closeBtn.addEventListener('click', () => this.actions.onHide())
    header.appendChild(closeBtn)

    const bodyEl = document.createElement('div')
    bodyEl.className = 'swd-dock-body'
    const treeEl = document.createElement('ul')
    treeEl.className = 'swd-tree'
    const emptyEl = document.createElement('div')
    emptyEl.className = 'swd-empty'
    emptyEl.style.display = 'none'
    const offlineEl = document.createElement('div')
    offlineEl.className = 'swd-offline'
    offlineEl.textContent = '离线（宿主路由不可达）'
    offlineEl.style.display = 'none'
    bodyEl.appendChild(offlineEl)
    bodyEl.appendChild(emptyEl)
    bodyEl.appendChild(treeEl)

    col.appendChild(header)
    col.appendChild(bodyEl)

    this.treeEl = treeEl
    this.emptyEl = emptyEl
    this.offlineEl = offlineEl
    this.col = col

    this.layout.mount(col)
  }

  /** 显示整列（0 宽 → 实际宽度）。 */
  show(): void {
    this.visible = true
    this.layout.applyGrid()
    if (this.lastSnapshot !== null) this.render(this.lastSnapshot)
  }

  /** 隐藏整列（收为 0 宽轨道，保持挂载）。 */
  hide(): void {
    this.visible = false
    this.layout.applyGrid()
  }

  /** 状态变化（宽度/折叠/可见性由 App 统一走 show/hide 或此方法）。 */
  syncLayout(): void {
    this.layout.applyGrid()
  }

  /** 离线提示（App 在传输失败时调用）。 */
  setOffline(offline: boolean): void {
    if (this.offlineEl !== null) this.offlineEl.style.display = offline ? 'block' : 'none'
    if (this.treeEl !== null) this.treeEl.style.display = offline ? 'none' : 'block'
    if (this.emptyEl !== null) this.emptyEl.style.display = 'none'
  }

  /** 渲染最新快照（App 轮询/SSE/current 变化时调用）。 */
  render(snapshot: AgentBoardSnapshot): void {
    this.lastSnapshot = snapshot
    if (!this.visible || this.treeEl === null || this.emptyEl === null) return
    this.setOffline(false)
    const currentId = this.ctx.sessions.list.getSnapshot().current
    renderBoardTree({
      treeEl: this.treeEl,
      emptyEl: this.emptyEl,
      titleEl: this.titleEl ?? undefined,
      snapshot,
      currentId,
      collapsedRoots: this.collapsedRoots,
      expandedRoots: this.expandedRoots,
      onOpen: (id, parentId) => this.actions.onOpen(id, parentId),
    })
  }

  /** 断开：卸载即净。 */
  dispose(): void {
    this.layout.dispose()
    this.col?.remove()
    this.col = null
  }
}
