/**
 * @dsh-external/dsh-subagent-watchdog — 浏览器半区：侧边栏「子代理监控」面板。
 *
 * Registers one `sidebar.footer.action` seat: a small trigger row (rail icon
 * when the sidebar is collapsed, icon + label when wide) that toggles a
 * floating panel. The panel polls `GET /api/subagent-watchdog/agents` every
 * {@link POLL_MS} and renders each live subagent with its status, last
 * activity, and silent duration; rows whose silent time exceeds the host
 * stall threshold are highlighted. Pure React + fetch — no store, no css
 * modules; the panel style is one injected <style> block.
 *
 * Failure policy: transport errors render an "offline" hint and keep the
 * poll alive; nothing throws (the web shell fails boot on apply throw).
 * @module @dsh-external/dsh-subagent-watchdog/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-slots SlotMap merge table (incl. ui-sidebar's
// 'sidebar.footer.action' declaration) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { useEffect, useRef, useState } from 'react'
import type { WatchdogSnapshot } from '../index.js'

/** Poll interval (ms) while the panel is open. */
const POLL_MS = 5000

/** localStorage key for the panel's open state (persisted across reloads). */
const LS_KEY = 'dsh.subagentWatchdog.open'

/** Panel styles, injected once into <head>. */
const PANEL_CSS = `
.swd-panel {
  position: fixed;
  top: 64px;
  right: 16px;
  z-index: 9999;
  width: 320px;
  max-height: 60vh;
  overflow-y: auto;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e6e6e6;
  background: rgba(17, 17, 20, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  user-select: none;
}
.swd-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
  color: #9ad0ff;
}
.swd-panel-close {
  cursor: pointer;
  color: #9aa0a6;
  border: none;
  background: none;
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
}
.swd-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  white-space: nowrap;
}
.swd-row:last-child { border-bottom: none; }
.swd-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.swd-dot-running { background: #4ade80; }
.swd-dot-idle { background: #6b7280; }
.swd-id { color: #d7dde3; }
.swd-meta { color: #9aa0a6; margin-left: auto; }
.swd-stall { color: #f87171; font-weight: 700; }
.swd-empty { color: #9aa0a6; padding: 6px 0; text-align: center; }
.swd-offline { color: #fbbf24; padding: 6px 0; text-align: center; }
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

/** 时间 → HH:MM:SS。 */
function formatClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 浮层面板：轮询快照并渲染子代理列表。 */
function WatchdogPanel(props: { onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<WatchdogSnapshot | null>(null)
  const [offline, setOffline] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const tick = (): void => {
      void fetch('/api/subagent-watchdog/agents')
        .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.json() as Promise<WatchdogSnapshot> })
        .then(data => { setSnapshot(data); setOffline(false) })
        .catch(() => setOffline(true))
    }
    tick()
    timer.current = window.setInterval(tick, POLL_MS)
    return () => { window.clearInterval(timer.current) }
  }, [])

  const rows = snapshot?.rows ?? []
  const threshold = snapshot?.stallThresholdMs ?? 0
  return (
    <div className="swd-panel">
      <style>{PANEL_CSS}</style>
      <div className="swd-panel-head">
        <span>子代理监控 {rows.length > 0 ? `(${rows.length})` : ''}</span>
        <button className="swd-panel-close" onClick={props.onClose} aria-label="关闭">✕</button>
      </div>
      {offline && <div className="swd-offline">离线（宿主路由不可达）</div>}
      {!offline && rows.length === 0 && <div className="swd-empty">无活跃子代理</div>}
      {rows.map(row => {
        const stalled = row.status === 'running' && row.silentMs > threshold
        return (
          <div className="swd-row" key={row.id} style={{ paddingLeft: Math.min(row.depth, 4) * 10 }}>
            <span className={`swd-dot ${row.status === 'running' ? 'swd-dot-running' : 'swd-dot-idle'}`} />
            <span className="swd-id" title={row.id}>{row.id.slice(0, 8)}</span>
            {stalled
              ? <span className="swd-stall">停滞 {formatDuration(row.silentMs)}</span>
              : <span className="swd-meta">{row.status} · 静默 {formatDuration(row.silentMs)}</span>}
            <span className="swd-meta">{formatClock(row.lastActivity)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 侧边栏 foot 触发器（rail 时仅图标，wide 时图标 + 文字）。 */
function WatchdogAction(props: { wide: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(LS_KEY) === '1')
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    localStorage.setItem(LS_KEY, next ? '1' : '0')
  }
  return (
    <>
      <button className="swd-action" onClick={toggle} title="子代理监控">
        <span>◉</span>
        {props.wide && <span>子代理</span>}
      </button>
      {open && <WatchdogPanel onClose={() => { setOpen(false); localStorage.setItem(LS_KEY, '0') }} />}
    </>
  )
}

/**
 * Client plugin body: register the sidebar footer action.
 * @param ctx - client root context (slots + cordis base).
 */
export const inject = ['slots'] as const

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-subagent-watchdog',
    order: 100,
    inject: () => ({}),
  }, WatchdogAction), 'watchdog: footer action')
}
