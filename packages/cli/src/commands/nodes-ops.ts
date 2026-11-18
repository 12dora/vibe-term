// `vibeterm nodes op clear` 与 `nodes upgrade cancel`。

import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { type SubHandler, confirmOrYes, emit, rejectExtra, requireArg } from '../core/cmd';
import { CliError, UsageError } from '../core/errors';
import { findMeshNode } from '../core/nodes-roster';
import { nodeLoginRequiredAuthError } from '../core/nodes-upgrade';
import { cancelNodeUpgrade } from '../core/nodes-upgrade';
import {
  isNodeLoginRequiredJobError,
  isPopAuthJobError,
  popNodeAuthError,
  remapPopNodeError,
} from '../core/session-pop';

export const op: SubHandler = async (ctx, _flags, positionals) => {
  const action = requireArg(positionals, 0, 'op (clear)');
  if (action !== 'clear') throw new UsageError(`unknown op: ${action}`, 'use clear');
  const ref = requireArg(positionals, 1, 'node');
  rejectExtra(positionals, 2);
  const node = await findMeshNode(ctx, ref);
  try {
    const result = await ctx.http.json(
      SELF_NODE_ID,
      'DELETE',
      `/api/mesh/nodes/${encodeURIComponent(node.id)}/operation`
    );
    emit(ctx, result ?? { ok: true, node: node.id }, () =>
      ctx.out.line(`cleared operation on ${node.name} (${node.id})`)
    );
  } catch (error) {
    throw remapPopNodeError(error, node.name);
  }
};

export const upgradeCancel: SubHandler = async (ctx, flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  await confirmOrYes(flags, `cancel the upgrade on ${node.name}`);
  let cancelled: Awaited<ReturnType<typeof cancelNodeUpgrade>>;
  try {
    cancelled = await cancelNodeUpgrade(ctx, node.id);
  } catch (error) {
    throw remapPopNodeError(error, node.name);
  }
  if (cancelled.kind !== 'cancelled') {
    if (isPopAuthJobError(cancelled.code)) {
      throw popNodeAuthError(node.name, cancelled.code);
    }
    if (isNodeLoginRequiredJobError(cancelled.code)) {
      throw nodeLoginRequiredAuthError(node.id);
    }
    throw new CliError(`upgrade cancel failed: ${cancelled.code ?? 'UPGRADE_FAILED'}`);
  }
  emit(ctx, { node: node.id, cancelled: true }, () =>
    ctx.out.line(`cancelled upgrade on ${node.name} (${node.id})`)
  );
};
