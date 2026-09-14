// `vibeterm nodes ports <node> [--probe]`

import type { MeshPortReach } from '@vibeterm/api-client/auth/types';
import { flagBool } from '../core/args';
import { type SubHandler, emit, rejectExtra, requireArg } from '../core/cmd';
import { printPortsTable, probeNodePorts } from '../core/nodes-ports';
import { findMeshNode } from '../core/nodes-roster';

export const ports: SubHandler = async (ctx, flags, positionals) => {
  const ref = requireArg(positionals, 0, 'node');
  rejectExtra(positionals, 1);
  const node = await findMeshNode(ctx, ref);
  const list: MeshPortReach[] = flagBool(flags, 'probe')
    ? await probeNodePorts(ctx, node.id)
    : (node.ports ?? []);
  emit(ctx, { node: node.id, ports: list }, () => printPortsTable(ctx, list));
};
