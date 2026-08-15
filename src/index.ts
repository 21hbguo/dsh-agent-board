/**
 * @dsh-external/dsh-subagent-watchdog — 子代理停滞检测器（host 半区）。
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
 *   DSH_WATCHDOG_SCAN_MS / DSH_WATCHDOG_STALL_MS / DSH_WATCHDOG_REMIND_MS
 *
 * 另注册 `GET /api/subagent-watchdog/agents` JSON 快照端点，供浏览器半区
 * （侧边栏「子代理监控」面板）轮询展示：每个子代理的状态、最后活动时间、
 * 静默时长（与阈值对比高亮）。
 */
import type { Context } from 'cordis'
import Schema from 'schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { makeWatchdogRoutes } from './routes.js'

export const name = '@dsh-external/dsh-subagent-watchdog'
export const inject = ['agents', 'webServer'] as const

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

/** 快照里一行子代理状态（浏览器面板渲染用）。 */
export interface AgentSnapshotRow {
  readonly id: string
  readonly status: 'idle' | 'running'
  /** 委派深度（0 = 顶层会话，子代理 ≥ 1）。 */
  readonly depth: number
  readonly parentSession?: string
  /** 最后一条 session 事件时间（Unix ms），无事件时回退到会话创建时间。 */
  readonly lastActivity: number
  /** 距最后活动的毫秒数。 */
  readonly silentMs: number
}

/** 一次快照的完整载荷。 */
export interface WatchdogSnapshot {
  readonly now: number
  readonly stallThresholdMs: number
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

/** subagent/end 事件的 run info 最小结构面。 */
interface SubagentEndInfoLike {
  readonly id: string
}

declare module 'cordis' {
  interface Context {
    readonly agents: AgentRegistryLike
  }
  interface Events {
    'session/event'(session: SessionLike, event: SessionEventLike): void
    'session/disposed'(session: SessionLike): void
    'subagent/end'(info: SubagentEndInfoLike, parent: AgentLike): void
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

export function apply(ctx: Context, config: Config): void {
  const scanIntervalMs = envMs('DSH_WATCHDOG_SCAN_MS') ?? config.scanIntervalMs
  const stallThresholdMs = envMs('DSH_WATCHDOG_STALL_MS') ?? config.stallThresholdMs
  const remindIntervalMs = envMs('DSH_WATCHDOG_REMIND_MS') ?? config.remindIntervalMs

  /** 子代理 id → 最后一条 session 事件时间（Unix ms）。 */
  const lastActivity = new Map<string, number>()
  /** 子代理 id → 上次提醒时间，节流用。 */
  const lastRemind = new Map<string, number>()

  const forget = (id: string): void => {
    lastActivity.delete(id)
    lastRemind.delete(id)
  }

  // 活动记账：子代理的每个 session 事件（turn/start、tool/start、
  // assistant/chunk、tool/result……）都刷新最后活动时间。
  ctx.on('session/event', (session, event) => {
    if (session.header.origin !== 'subagent') return
    lastActivity.set(session.id, event.time)
  })

  // 结束/销毁即清账，避免对已完成的子代理继续提醒。
  ctx.on('subagent/end', info => forget(info.id))
  ctx.on('session/disposed', session => forget(session.id))
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') forget(agent.id)
  })

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
        { type: 'text', text: `[watchdog] ${summary}（最后活动 ${lastAt}）。` },
        { type: 'text', text: '处理建议：send_message 催一下进度；interrupt_agent 中断后重派；确认是长任务请忽略本条。' },
      ],
      source: {
        kind: 'plugin',
        plugin: 'dsh-subagent-watchdog',
        form: 'notice',
        summary: boundContextSummary(summary),
      },
    })
    parent.inject(message)
    ctx.logger.info(`[watchdog] ${summary}; notice injected into parent ${parentId}`)
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
  }, 'watchdog.scan')

  // JSON 快照：浏览器半区的「子代理监控」面板轮询此端点。
  const snapshot = (): WatchdogSnapshot => {
    const now = Date.now()
    const rows: AgentSnapshotRow[] = []
    for (const agent of ctx.agents.list()) {
      if (agent.session.header.origin !== 'subagent') continue
      const events = agent.session.events
      const last = lastActivity.get(agent.id)
        ?? events.at(-1)?.time
        ?? agent.session.header.createdAt
      rows.push({
        id: agent.id,
        status: agent.status,
        depth: agent.session.header.delegationDepth ?? 0,
        parentSession: agent.session.header.parentSession,
        lastActivity: last,
        silentMs: now - last,
      })
    }
    rows.sort((a, b) => a.depth - b.depth || a.silentMs - b.silentMs)
    return { now, stallThresholdMs, rows }
  }

  ctx.effect(() => {
    const disposers = makeWatchdogRoutes({ snapshot }).map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'watchdog: routes')

  ctx.logger.info(
    `[watchdog] armed: stall=%dms scan=%dms remind=%dms`,
    stallThresholdMs,
    scanIntervalMs,
    remindIntervalMs,
  )
}
