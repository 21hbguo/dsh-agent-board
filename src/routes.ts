/**
 * dsh-agent-board HTTP routes — the browser half polls a single
 * same-origin JSON endpoint for the live subagent snapshot. One tiny surface:
 * `GET /api/agent-board/agents` answered from the agent-board's ledger.
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
export function makeAgentBoardRoutes(deps: { snapshot: () => AgentBoardSnapshot }): WebRoute[] {
  const { snapshot } = deps
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
  ]
}
