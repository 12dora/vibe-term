// Mesh 节点端口可达表：读 MeshNode.ports，可选先 POST …/ports/probe。

import type { MeshPortReach } from '@vibeterm/api-client/auth/types';
import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { dash } from './cmd';
import type { CliContext } from './context';

export function formatPortNumber(port: MeshPortReach): string {
  if (typeof port.port === 'number') return String(port.port);
  if (port.range) return `${port.range.begin}-${port.range.end}`;
  return '-';
}

export function formatPortCheckedAt(checkedAt: number | undefined): string {
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return '-';
  return new Date(checkedAt).toISOString();
}

export function printPortsTable(ctx: CliContext, ports: MeshPortReach[]): void {
  if (ports.length === 0) {
    ctx.out.line('ports          -');
    return;
  }
  ctx.out.table(ports, [
    { header: 'PURPOSE', value: (row) => row.purpose },
    { header: 'PORT', value: formatPortNumber },
    { header: 'PROTO', value: (row) => row.proto },
    { header: 'STATUS', value: (row) => row.status },
    { header: 'CODE', value: (row) => dash(row.code) },
    { header: 'CHECKED', value: (row) => formatPortCheckedAt(row.checkedAt) },
  ]);
}

export async function probeNodePorts(ctx: CliContext, nodeId: string): Promise<MeshPortReach[]> {
  const payload = await ctx.http.json<{ ports?: MeshPortReach[] }>(
    SELF_NODE_ID,
    'POST',
    `/api/mesh/nodes/${encodeURIComponent(nodeId)}/ports/probe`
  );
  return Array.isArray(payload.ports) ? payload.ports : [];
}
