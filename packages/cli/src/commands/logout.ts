// `vibeterm logout`：向持有会话的每个 node 发一次 `/api/auth/logout`（各自撤销该用户的全部
// 会话），再删掉本地会话文件里的这条 entry。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import type { Command } from './types';

interface LogoutOutcome {
  node: string;
  revoked: boolean;
  status?: number;
  error?: string;
}

/** entry 自身放最后：先撤远端，转发链路才还活着。 */
function orderedNodeIds(ids: readonly string[]): string[] {
  const others = ids.filter((id) => id !== SELF_NODE_ID).sort();
  return ids.includes(SELF_NODE_ID) ? [...others, SELF_NODE_ID] : others;
}

async function revoke(ctx: CliContext, nodeId: string): Promise<LogoutOutcome> {
  try {
    const response = await ctx.http.fetch(nodeId, '/api/auth/logout', { method: 'POST' });
    return { node: nodeId, revoked: response.ok, status: response.status };
  } catch (error) {
    return {
      node: nodeId,
      revoked: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function run(ctx: CliContext, argv: string[]): Promise<undefined> {
  parseArgv(argv, {});
  const entry = ctx.globals.entry;
  const nodeIds = orderedNodeIds(ctx.http.jar.list().map((session) => session.nodeId));
  const outcomes: LogoutOutcome[] = [];
  for (const nodeId of nodeIds) {
    outcomes.push(await revoke(ctx, nodeId));
  }

  ctx.sessions.clearEntry(entry);
  ctx.sessions.save();

  if (ctx.globals.json) {
    ctx.out.data({ entry, nodes: outcomes, sessionFile: ctx.sessions.path });
    return;
  }
  if (outcomes.length === 0) {
    ctx.out.info(`no stored session for ${entry}`);
    return;
  }
  ctx.out.table(outcomes, [
    { header: 'NODE', value: (row) => row.node },
    {
      header: 'REVOKED',
      value: (row) => (row.revoked ? 'yes' : `no (${row.error ?? `HTTP ${row.status}`})`),
    },
  ]);
  ctx.out.info(`local session for ${entry} removed`);
}

export const command: Command = {
  name: 'logout',
  summary: 'revoke sessions on every logged-in node and drop the local session file entry',
  usage: [
    'Usage: vibeterm logout [--entry <url>]',
    '',
    'Posts /api/auth/logout to every node this entry holds a session for (each node revokes',
    'all of the user’s sessions it issued), then removes the entry from the session file.',
  ].join('\n'),
  run,
};
