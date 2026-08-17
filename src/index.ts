/**
 * @dsh-external/dsh-agent-board — 子代理停滞检测器（host 半区）。
 *
 * 问题背景：后台子代理（subagent）卡住时——工具调用死等、LLM 挂起、自循环、
 * 等待永远不来的输入——父会话（老板）收不到任何信号。宿主只在子代理真正
 * settle 时才投递 `subagent-settled` notice，而卡住的 agent 可能永远不
 * settle；`list_agents` 又只给 running/idle/ready，没有活动时间戳。老板
 * 只能靠主动轮询 + 催进度，卡了都不知道。
 *
 * 本插件补上这个洞：监听全局 `session/event`（每个事件自带毫秒时间戳，
 * 精确到最后一条 chunk/工具事件），维护每个子代理的「最后活动时间」；
 * 定时扫描所有 running 的子代理，静默超过阈值时自动向其父会话注入一条
 * notice（GUI 可见、不唤醒模型、不耗 API 额度）。老板在下一个自然 step
 * 看到提醒，自行决定：`send_message` 催一下 / `interrupt_agent` 中断重派 /
 * 已知是长任务则忽略。
 *
 * 误报控制：默认阈值 10 分钟，高于 LLM 适配器流空闲兜底（5 分钟断流），
 * 纯模型挂起会被适配器兜底产生事件或 settle，不会误报；主要误报来源是
 * 长时间无输出的工具调用（sleep、大构建、长测试），notice 文案会提示
 * 「可能是长任务」。同一子代理的重复提醒受 remindIntervalMs 节流。
 *
 * 阈值可用环境变量覆盖（便于测试与按任务调优）：
 *   DSH_AGENT_BOARD_SCAN_MS / DSH_AGENT_BOARD_STALL_MS / DSH_AGENT_BOARD_REMIND_MS
 *
 * 另注册 `GET /api/agent-board/agents` JSON 快照端点，供浏览器半区
 * （侧边栏「子代理监控」面板）轮询展示：每个子代理的状态、最后活动时间、
 * 静默时长（与阈值对比高亮）。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeAgentBoardRoutes } from './routes.js'

export const name = '@dsh-external/dsh-agent-board'
export const inject = ['agents', 'webServer', 'subagents', 'workspaceRegistry'] as const

/** 配置：扫描周期 / 停滞阈值 / 重复提醒节流（毫秒）。 */
export interface Config {
  scanIntervalMs: number
  stallThresholdMs: number
  remindIntervalMs: number
}

export const Config: Schema<Config> = Schema.object({
  scanIntervalMs: Schema.natural().min(5_000).default(60_000),
  stallThresholdMs: Schema.natural().min(10_000).default(600_000),
  remindIntervalMs: Schema.natural().min(10_000).default(600_000),
})

// ---------------------------------------------------------------- 结构面

/** 节点当前动作（“正在做什么”的实时信号）。 */
export type AgentAction =
  | { readonly kind: 'tool'; readonly text: string }
  | { readonly kind: 'streaming' }

/** 快照里一行 agent 状态（浏览器面板渲染用）。
 *  `running` = working（在跑）；`idle` = live 但空闲；`finished` = 已 settle
 *  的存档行（完成态，用户点进去看过后由浏览器转为空闲并超时消失）。 */
export interface AgentSnapshotRow {
  readonly id: string
  readonly status: 'idle' | 'running' | 'finished'
  /** 委派深度（0 = 顶层会话，子代理 ≥ 1）。 */
  readonly depth: number
  readonly parentSession?: string
  /** 会话创建时间（Unix ms）——稳定排序键，保证看板节点位置不跳动。 */
  readonly createdAt: number
  /** 最后一条 session 事件时间（Unix ms），无事件时回退到会话创建时间。 */
  readonly lastActivity: number
  /** 距最后活动的毫秒数。 */
  readonly silentMs: number
  /** 该 agent 最新一条 assistant 答复的文本节选（无则缺省）。 */
  readonly lastReply?: string
  /** 当前动作：正在执行的工具 / 正在流式输出。 */
  readonly action?: AgentAction
  /** 创建时的名字（descriptor label，懒解析；无则缺省）。 */
  readonly label?: string
  /** 会话显示标题（`session/title` 事件最新值；无则缺省，浏览器兜底 id）。 */
  readonly title?: string
  /** 会话里是否有对话消息（user/assistant message 事件）。无对话的空白会话
   *  看板不显示；子代理与存档行恒有对话，此字段缺省。 */
  readonly hasMessages?: boolean
  /** 等待人工介入的原因（ask 类工具挂起 / 审批等待）。看板黄色圈提醒。 */
  readonly waiting?: string
}

/** 一次快照的完整载荷。 */
export interface AgentBoardSnapshot {
  readonly now: number
  readonly stallThresholdMs: number
  /** 顶层会话（主 agent 们），每个下面挂自己的子代理树。 */
  readonly roots: readonly AgentSnapshotRow[]
  readonly rows: readonly AgentSnapshotRow[]
}

/** SessionHeader 最小结构面（@deepseek-ai/dsh-session 的 SessionHeader）。 */
interface SessionHeaderLike {
  readonly id: string
  readonly createdAt: number
  readonly parentSession?: string
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
}

/** SessionEvent 最小结构面（每个事件自带 Unix 毫秒时间戳）。 */
interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  /** 相关事件的载荷（只取需要的面）。 */
  readonly data?: {
    readonly message?: {
      readonly content?: readonly { readonly type?: string; readonly text?: string }[]
    }
    readonly name?: string
    readonly arguments?: string
    readonly title?: string
  }
}

/** Session 最小结构面。 */
interface SessionLike {
  readonly id: string
  readonly header: SessionHeaderLike
  readonly events: readonly SessionEventLike[]
}

/** Agent 最小结构面（@deepseek-ai/dsh-agent 的 Agent）。 */
interface AgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: SessionLike
  inject(message: ReturnType<typeof createUserMessage>): void
}

/** ctx.agents registry 最小服务面。 */
interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
  list(): AgentLike[]
}

/** ctx.subagents 服务面（只取 label 解析用到的面）。 */
interface SubagentsLike {
  listChildren(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly { readonly kind: string; readonly id: string; readonly label?: string }[]>
}

/** subagent/end 事件的 run info 最小结构面。 */
interface SubagentEndInfoLike {
  readonly id: string
}

declare module 'cordis' {
  interface Context {
    readonly agents: AgentRegistryLike
    readonly subagents: SubagentsLike
    /** 工作区注册表（归档会话集合；归档的主 agent 连同其子代理树一起从看板隐藏）。 */
    readonly workspaceRegistry: {
      readonly archivedSessionIds: readonly string[]
    }
  }
  interface Events {
    'session/event'(session: SessionLike, event: SessionEventLike): void
    'session/disposed'(session: SessionLike): void
    'subagent/end'(info: SubagentEndInfoLike, parent: AgentLike): void
    'agent/created'(payload: { agent: AgentLike }): void
    'agent/disposed'(payload: { agent: AgentLike }): void
  }
}

// ---------------------------------------------------------------- 实现

/** 环境变量覆盖（数字毫秒），便于测试与按任务调优。 */
function envMs(key: string): number | undefined {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 人类可读的静默时长。 */
function formatSilent(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return `${Math.floor(ms / 1000)} 秒`
  if (totalMin < 60) return `${totalMin} 分钟`
  return `${Math.floor(totalMin / 60)} 小时 ${totalMin % 60} 分钟`
}

/** 从 assistant 消息的 content 块里提取纯文本（拼接、去空白）。 */
function extractReplyText(content: readonly { readonly type?: string; readonly text?: string }[] | undefined): string {
  if (content === undefined) return ''
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 节选上限（字符）。 */
const REPLY_EXCERPT_MAX = 80

/** 截断为一行节选。 */
function excerpt(text: string, max = REPLY_EXCERPT_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/** 从工具调用参数 JSON 里提取可读摘要（bash → command 字段，其他取首个字符串值）。 */
function toolArgsSummary(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.command === 'string' && parsed.command.trim() !== '') return parsed.command.trim()
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  } catch { /* 非 JSON 参数按原文处理 */ }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 40)
}

/** 当前动作文本上限。 */
const ACTION_MAX = 60

export function apply(ctx: Context, config: Config): void {
  const scanIntervalMs = envMs('DSH_AGENT_BOARD_SCAN_MS') ?? config.scanIntervalMs
  const stallThresholdMs = envMs('DSH_AGENT_BOARD_STALL_MS') ?? config.stallThresholdMs
  const remindIntervalMs = envMs('DSH_AGENT_BOARD_REMIND_MS') ?? config.remindIntervalMs

  /** 会话 id → 最后一条 session 事件时间（Unix ms）。 */
  const lastActivity = new Map<string, number>()
  /** 子代理 id → 上次提醒时间，节流用。 */
  const lastRemind = new Map<string, number>()
  /** 会话 id → 最新一条 assistant 答复的节选文本。 */
  const lastReply = new Map<string, string>()
  /** 会话 id → 当前动作（正在执行的工具 / 正在输出）。 */
  const lastAction = new Map<string, AgentAction>()
  /** 会话 id → 显示标题（`session/title` 事件增量缓存）。 */
  const titleCache = new Map<string, string>()
  /** 子代理 id → 创建时的名字（descriptor label，懒查询缓存）。 */
  const labelCache = new Map<string, string>()
  /** 正在查询 label 的子代理 id（去重）。 */
  const labelPending = new Set<string>()
  /** 会话 id → 等待人工的原因（ask 类工具挂起 / 审批等待；黄色圈提醒）。 */
  const waitingHuman = new Map<string, string>()
  /** 会话 id → 最近一次 tool/call 的工具名（tool/result 回查用）。 */
  const lastToolName = new Map<string, string>()
  /** 主 agent 会话 id → 最后完成时刻（turn/end；完成态蓝/灰，点开已读由浏览器处理）。 */
  const rootFinished = new Map<string, number>()

  // ---------------------------------------------------------- 存档持久化
  /** 完成态存档落盘路径（~/.dsh/agent-board-archive.json，重启恢复）。 */
  const ARCHIVE_PATH = join(homedir(), '.dsh', 'agent-board-archive.json')
  let persistTimer: NodeJS.Timeout | undefined
  const persistArchive = (): void => {
    if (persistTimer !== undefined) return
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      try {
        const body = JSON.stringify({ records: [...settledArchive.values()] })
        const tmp = `${ARCHIVE_PATH}.tmp`
        mkdirSync(homedir() + '/.dsh', { recursive: true })
        writeFileSync(tmp, body, 'utf8')
        renameSync(tmp, ARCHIVE_PATH)
      } catch (error) {
        ctx.logger.warn(`[agent-board] 存档写盘失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 300)
  }
  const loadArchive = (): void => {
    try {
      if (!existsSync(ARCHIVE_PATH)) return
      const parsed = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf8')) as { records?: Array<AgentSnapshotRow & { endedAt: number }> }
      const now = Date.now()
      for (const record of parsed.records ?? []) {
        if (now - record.endedAt <= ARCHIVE_KEEP_MS) {
          // 旧版存档无 createdAt：用 lastActivity 兜底（稳定排序键）。
          settledArchive.set(record.id, { ...record, createdAt: record.createdAt ?? record.lastActivity })
        }
      }
    } catch (error) {
      ctx.logger.warn(`[agent-board] 存档读盘失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---------------------------------------------------------- SSE 推送
  /** SSE 客户端连接（浏览器 EventSource）。 */
  const sseClients = new Set<import('node:http').ServerResponse>()
  let notifyTimer: NodeJS.Timeout | undefined
  /** 数据变化信号（节流 500ms 合并高频事件，如流式 chunk）。 */
  const notifyChanged = (): void => {
    if (notifyTimer !== undefined) return
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined
      for (const res of sseClients) {
        try { res.write('data: changed\n\n') } catch { /* 已断开连接忽略 */ }
      }
    }, 500)
  }

  /** 懒解析子代理创建名：对父会话调 listChildren 一次拿全部直接子。 */
  const ensureLabel = (id: string, parentSession: string | undefined): void => {
    if (parentSession === undefined) return
    if (labelCache.has(id) || labelPending.has(id)) return
    labelPending.add(id)
    void ctx.subagents.listChildren(parentSession, AbortSignal.timeout(3_000))
      .then(entries => {
        for (const entry of entries) {
          if (entry.label !== undefined && entry.label !== '') labelCache.set(entry.id, entry.label)
        }
      })
      .catch(error => {
        ctx.logger.warn(`[agent-board] label 解析失败 ${id}: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { labelPending.delete(id) })
  }

  const forget = (id: string): void => {
    lastActivity.delete(id)
    lastRemind.delete(id)
    lastReply.delete(id)
    lastAction.delete(id)
    waitingHuman.delete(id)
    lastToolName.delete(id)
    rootFinished.delete(id)
    titleCache.delete(id)
    labelCache.delete(id)
    labelPending.delete(id)
  }

  // 活动记账：所有会话的每个 session 事件（turn/start、tool/start、
  // assistant/chunk、tool/result……）都刷新最后活动时间；子代理额外记录
  // 答复节选与当前动作（工具执行中最后事件是 tool/call，流式输出中最后
  // 事件是 assistant/chunk——天然可推断「正在做什么」）。
  ctx.on('session/event', (session, event) => {
    lastActivity.set(session.id, event.time)
    switch (event.type) {
      case 'session/title': {
        const title = event.data?.title
        if (typeof title === 'string' && title !== '') titleCache.set(session.id, title)
        break
      }
      case 'assistant/message': {
        const text = extractReplyText(event.data?.message?.content)
        if (text.length > 0) lastReply.set(session.id, text)
        lastAction.delete(session.id)
        break
      }
      case 'tool/call': {
        const name = event.data?.name ?? 'tool'
        const summary = toolArgsSummary(event.data?.arguments ?? '')
        lastAction.set(session.id, {
          kind: 'tool',
          text: excerpt(`${name}: ${summary}`, ACTION_MAX),
        })
        lastToolName.set(session.id, name)
        // ask 类工具挂起 = 等人回答（tool/result 前一直保持）
        if (/^ask/i.test(name)) waitingHuman.set(session.id, `等待回答（${name}）`)
        break
      }
      case 'tool/result': {
        lastAction.delete(session.id)
        const name = lastToolName.get(session.id)
        if (name !== undefined && /^ask/i.test(name)) waitingHuman.delete(session.id)
        lastToolName.delete(session.id)
        break
      }
      case 'approval/asked':
        // 权限审批等待人工决定
        waitingHuman.set(session.id, '等待审批')
        break
      case 'approval/decided':
        waitingHuman.delete(session.id)
        break
      case 'turn/start':
        // 主 agent 开始新一轮：清除完成态
        if (session.header.origin !== 'subagent') rootFinished.delete(session.id)
        break
      case 'turn/end':
        // 主 agent 每轮 turn 结束 = 完成（标蓝；浏览器点开已读转灰）。
        // 同时清当前动作——turn 结束后不再显示「⚙ 工具执行中」，
        // 避免 agent.status 滞后/工具 result 事件缺失导致「完成了还显示 running+bash」。
        lastAction.delete(session.id)
        if (session.header.origin !== 'subagent') rootFinished.set(session.id, event.time)
        break
      case 'assistant/chunk':
        lastAction.set(session.id, { kind: 'streaming' })
        break
      default:
        break
    }
    notifyChanged()
  })

  /** 已 settle 的子代理存档（完成态，供看板保留「点进去之前」的记录）。 */
  const settledArchive = new Map<string, AgentSnapshotRow & { readonly endedAt: number }>()
  /** 存档保留时长：超过后从快照移除（防内存增长）。 */
  const ARCHIVE_KEEP_MS = 4 * 60 * 60_000
  /** 主 agent 完成态保留时长（turn 结束后标蓝/灰，60 分钟自动消失——比子代理 5 分钟久）。 */
  const ROOT_FINISHED_KEEP_MS = 60 * 60_000

  /** 子代理 settle 时把最终信息存档（status=finished），不随 agent dispose 丢失。
   *  幂等：已存档则跳过。subagent/end 与 agent/disposed 谁先到谁存档。 */
  const archiveSettled = (agent: AgentLike): void => {
    if (settledArchive.has(agent.id)) return
    if (agent.session.header.origin !== 'subagent') return
    const header = agent.session.header
    const endedAt = Date.now()
    const last = lastActivity.get(agent.id) ?? endedAt
    settledArchive.set(agent.id, {
      id: agent.id,
      status: 'finished',
      depth: header.delegationDepth ?? 0,
      parentSession: header.parentSession,
      createdAt: header.createdAt,
      lastActivity: last,
      silentMs: 0,
      ...(lastReply.has(agent.id) ? { lastReply: excerpt(lastReply.get(agent.id)!) } : {}),
      ...(labelCache.get(agent.id) !== undefined ? { label: labelCache.get(agent.id)! } : {}),
      ...(titleCache.get(agent.id) !== undefined ? { title: titleCache.get(agent.id)! } : {}),
      endedAt,
    })
    persistArchive()
    notifyChanged()
  }

  // 启动时恢复持久化存档（重启后完成态不丢）。
  loadArchive()

  // 结束/销毁即清账：先存档（读各记账 Map），再清理。
  ctx.on('subagent/end', info => {
    const agent = ctx.agents.get(info.id)
    if (agent !== undefined) archiveSettled(agent)
    forget(info.id)
    notifyChanged()
  })
  ctx.on('session/disposed', session => forget(session.id))
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') {
      archiveSettled(agent)
      forget(agent.id)
    }
    notifyChanged()
  })

  /** 从会话事件日志回填最新标题（session/title 事件，last-wins）。 */
  const warmupTitle = (agent: AgentLike): void => {
    const events = agent.session.events
    for (let i = events.length - 1; i >= 0; i--) {
      const title = events[i].data?.title
      if (events[i].type === 'session/title' && typeof title === 'string' && title !== '') {
        titleCache.set(agent.id, title)
        break
      }
    }
  }

  // agent 装配（含重启后恢复装配）时回填标题：插件 apply 可能早于 agent
  // 装配，且 session/title 是历史事件不会重放，必须在此兜底。
  ctx.on('agent/created', ({ agent }) => warmupTitle(agent))

  // 启动预热：为已存在的会话回填标题（插件装配前产生的 session/title 事件）。
  for (const agent of ctx.agents.list()) warmupTitle(agent)

  /** 向停滞子代理的父会话注入一条 notice（静默排队，不唤醒模型）。 */
  const remind = (agent: AgentLike, silentForMs: number): void => {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return
    const parent = ctx.agents.get(parentId)
    if (parent === undefined) return
    const last = lastActivity.get(agent.id)
    const lastAt = last === undefined ? '未知' : new Date(last).toLocaleTimeString()
    const summary = `子代理 ${agent.id.slice(0, 8)} 已静默 ${formatSilent(silentForMs)}，可能卡住（也可能是长任务）`
    const message = createUserMessage({
      content: [
        { type: 'text', text: `[agent-board] ${summary}（最后活动 ${lastAt}）。` },
        { type: 'text', text: '处理建议：send_message 催一下进度；interrupt_agent 中断后重派；确认是长任务请忽略本条。' },
      ],
      source: {
        kind: 'plugin',
        plugin: 'dsh-agent-board',
        form: 'notice',
        summary: boundContextSummary(summary),
      },
    })
    parent.inject(message)
    ctx.logger.info(`[agent-board] ${summary}; notice injected into parent ${parentId}`)
  }

  /** 一轮扫描：找「running 但静默超阈值」的子代理。 */
  const scan = (): void => {
    const now = Date.now()
    for (const agent of ctx.agents.list()) {
      if (agent.session.header.origin !== 'subagent') continue
      if (agent.status !== 'running') continue
      const events = agent.session.events
      const last = lastActivity.get(agent.id)
        ?? events.at(-1)?.time
        ?? agent.session.header.createdAt
      const silentFor = now - last
      if (silentFor < stallThresholdMs) continue
      if (now - (lastRemind.get(agent.id) ?? 0) < remindIntervalMs) continue
      lastRemind.set(agent.id, now)
      remind(agent, silentFor)
    }
  }

  ctx.effect(() => {
    const timer = setInterval(scan, scanIntervalMs)
    return () => clearInterval(timer)
  }, 'agent-board.scan')

  // JSON 快照：浏览器半区的「Agent 看板」轮询此端点。顶层会话进 roots，
  // 子代理进 rows（parentSession 关联成树）。
  /** 归档集合（含级联）：归档的主 agent + 其整个子代理后代都不显示。 */
  const archivedSet = (): Set<string> => {
    const archived = new Set<string>(ctx.workspaceRegistry.archivedSessionIds)
    let grew = true
    while (grew) {
      grew = false
      const cascade = (parent: string | undefined, child: string): void => {
        if (parent !== undefined && archived.has(parent) && !archived.has(child)) {
          archived.add(child)
          grew = true
        }
      }
      for (const agent of ctx.agents.list()) cascade(agent.session.header.parentSession, agent.id)
      for (const [, record] of settledArchive) cascade(record.parentSession, record.id)
    }
    return archived
  }

  const snapshot = (): AgentBoardSnapshot => {
    const now = Date.now()
    const archived = archivedSet()
    const roots: AgentSnapshotRow[] = []
    const rows: AgentSnapshotRow[] = []
    for (const agent of ctx.agents.list()) {
      // 归档会话（含被级联的子代理）不显示。
      if (archived.has(agent.id)) continue
      const header = agent.session.header
      const events = agent.session.events
      const last = lastActivity.get(agent.id)
        ?? events.at(-1)?.time
        ?? header.createdAt
      const label = header.origin === 'subagent' ? labelCache.get(agent.id) : undefined
      const row: AgentSnapshotRow = {
        id: agent.id,
        status: agent.status,
        depth: header.delegationDepth ?? 0,
        parentSession: header.parentSession,
        createdAt: header.createdAt,
        lastActivity: last,
        silentMs: now - last,
        ...(lastReply.has(agent.id) ? { lastReply: excerpt(lastReply.get(agent.id)!) } : {}),
        ...(lastAction.has(agent.id) ? { action: lastAction.get(agent.id) } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(titleCache.has(agent.id) ? { title: titleCache.get(agent.id) } : {}),
        ...(waitingHuman.has(agent.id) ? { waiting: waitingHuman.get(agent.id)! } : {}),
      }
      if (header.origin === 'subagent') {
        if (label === undefined) ensureLabel(agent.id, header.parentSession)
        rows.push(row)
      } else {
        // 顶层会话记录「是否有对话消息」——空白会话（从未收发消息）看板不显示。
        // 完成态：idle 且 turn/end 过且在保留期内 → status 标 finished（蓝/灰，浏览器已读逻辑）。
        const endedAt = rootFinished.get(agent.id)
        let rootStatus = row.status
        if (endedAt !== undefined && now - endedAt <= ROOT_FINISHED_KEEP_MS) {
          // turn/end 已发生（事件流为准）→ 完成态；不依赖 agent.status——
          // 状态机滞后时也显示「完成」而非错误的「运行中」。
          rootStatus = 'finished'
        } else if (endedAt !== undefined && now - endedAt > ROOT_FINISHED_KEEP_MS) {
          rootFinished.delete(agent.id)
        }
        roots.push({
          ...row,
          status: rootStatus,
          hasMessages: events.some(e => e.type === 'user/message' || e.type === 'assistant/message'),
        })
      }
    }
    // 完成态存档：settle 过的子代理保留在板上（浏览器决定何时因「已点开」转空闲并消失）。
    for (const [id, record] of settledArchive) {
      if (archived.has(id) || archived.has(record.parentSession ?? '')) continue
      if (now - record.endedAt > ARCHIVE_KEEP_MS) {
        settledArchive.delete(id)
        persistArchive()
        continue
      }
      rows.push({ ...record, silentMs: now - record.lastActivity })
    }
    // 稳定排序：按创建时间（新的在上），位置不随时间跳动；
    // 存档行 createdAt 与 live 行同键，混排一致。
    roots.sort((a, b) => b.createdAt - a.createdAt)
    rows.sort((a, b) => a.depth - b.depth || b.createdAt - a.createdAt)
    return { now, stallThresholdMs, roots, rows }
  }

  // SSE 心跳：30s 注释帧防代理断连。
  ctx.effect(() => {
    const heartbeat = setInterval(() => {
      for (const res of sseClients) {
        try { res.write(': ping\n\n') } catch { /* 已断开忽略 */ }
      }
    }, 30_000)
    return () => clearInterval(heartbeat)
  }, 'agent-board: sse heartbeat')

  ctx.effect(() => {
    const disposers = makeAgentBoardRoutes({ snapshot, sseClients }).map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'agent-board: routes')

  ctx.logger.info(
    `[agent-board] armed: stall=%dms scan=%dms remind=%dms`,
    stallThresholdMs,
    scanIntervalMs,
    remindIntervalMs,
  )
}
