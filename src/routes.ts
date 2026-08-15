/**
 * dsh-agent-board HTTP routes — the browser half polls one same-origin JSON
 * endpoint for the live snapshot, and subscribes to one SSE endpoint for
 * instant "data changed" signals (the poll stays as fallback/reconnect).
 * `GET /api/agent-board/agents` and `GET /api/agent-board/stream`.
 * @module @dsh-external/dsh-agent-board/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { AgentBoardSnapshot } from './index.js'

/** Browser-facing base path of the agent-board API. */
export const AGENT_BOARD_API_PREFIX = '/api/agent-board'

/** Write one JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Build the full route family for one agent-board snapshot provider. */
export function makeAgentBoardRoutes(deps: {
  snapshot: () => AgentBoardSnapshot
  /** SSE 客户端集合：连接注册/注销由路由管理，心跳与信号帧由宿主写入。 */
  sseClients: Set<ServerResponse>
}): WebRoute[] {
  const { snapshot, sseClients } = deps
  return [
    {
      kind: 'exact',
      path: `${AGENT_BOARD_API_PREFIX}/agents`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        json(res, 200, snapshot())
      },
    },
    {
      kind: 'exact',
      path: `${AGENT_BOARD_API_PREFIX}/stream`,
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        sseClients.add(res)
        req.on('close', () => { sseClients.delete(res) })
      },
    },
  ]
}
