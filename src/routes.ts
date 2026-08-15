/**
 * dsh-subagent-watchdog HTTP routes — the browser half polls a single
 * same-origin JSON endpoint for the live subagent snapshot. One tiny surface:
 * `GET /api/subagent-watchdog/agents` answered from the watchdog's ledger.
 * @module @dsh-external/dsh-subagent-watchdog/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { WatchdogSnapshot } from './index.js'

/** Browser-facing base path of the watchdog API. */
export const WATCHDOG_API_PREFIX = '/api/subagent-watchdog'

/** Write one JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Build the full route family for one watchdog snapshot provider. */
export function makeWatchdogRoutes(deps: { snapshot: () => WatchdogSnapshot }): WebRoute[] {
  const { snapshot } = deps
  return [
    {
      kind: 'exact',
      path: `${WATCHDOG_API_PREFIX}/agents`,
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
