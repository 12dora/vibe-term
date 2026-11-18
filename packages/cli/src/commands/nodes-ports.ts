// `vibeterm nodes ports <node> [--probe]`

import type { MeshPortReach } from '@vibeterm/api-client/auth/types';
import { flagBool } from '../core/args';
import { type SubHandler, emit, rejectExtra, requireArg } from '../core/cmd';
import { printPortsTable, probeNodePorts } from '../core/nodes-ports';
import { findMeshNode } from '../core/nodes-roster';
import { remapPopNodeError } from '../core/session-pop';

export const ports: SubHandler = async (ctx, flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  let list: MeshPortReach[];
  try {
    list = flagBool(flags, 'probe') ? await probeNodePorts(ctx, node.id) : (node.ports ?? []);
  } catch (error) {
    throw remapPopNodeError(error, node.name);
  }
  emit(ctx, { node: node.id, ports: list }, () => printPortsTable(ctx, list));
};
