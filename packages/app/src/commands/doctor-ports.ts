import { formatHttpEndpoint, rewriteWildcardBindHost } from '../../../shared/src/network';
import { t } from '../i18n';
import type { FetchLike } from '../lib/fetch-like';
import {
  type PortPlanEnv,
  formatPortPlanForEnv,
  portPlanFromEnv,
} from '../runtime/local-port-plan';
import type { DoctorCheck } from '../types';

export type TcpListenProbe = (host: string, port: number) => Promise<boolean>;

const PEER_PROBE_TIMEOUT_MS = 1000;
const MESH_FETCH_TIMEOUT_MS = 3000;

export async function isTcpListening(
  host: string,
  port: number,
  timeoutMs = PEER_PROBE_TIMEOUT_MS
): Promise<boolean> {
  try {
    const socket = await Promise.race([
      Bun.connect({
        hostname: host,
        port,
        socket: { data() {}, close() {}, error() {} },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    socket.end();
    return true;
  } catch {
    return false;
  }
}

function peerProbeHost(bindHost: string | undefined): string {
  const first = bindHost?.split(',')[0]?.trim() || '127.0.0.1';
  return rewriteWildcardBindHost(first);
}

export function portPlanDoctorChecks(env: PortPlanEnv): DoctorCheck[] {
  const list = formatPortPlanForEnv(env);
  if (!list) return [];
  return [
    {
      id: 'ports.plan',
      level: 'pass',
      message: t('doctor.ports.plan', { list }),
    },
  ];
}

export async function peerPortDoctorCheck(
  env: PortPlanEnv,
  probe: TcpListenProbe = isTcpListening
): Promise<DoctorCheck | null> {
  const peer = portPlanFromEnv(env).find((spec) => spec.purpose === 'peer-signaling' && spec.port);
  if (!peer?.port) return null;
  const host = peerProbeHost(env.VIBETERM_PEER_BIND_HOST);
  const bound = await probe(host, peer.port);
  return {
    id: 'ports.peer',
    level: bound ? 'pass' : 'warn',
    message: t(bound ? 'doctor.ports.peerListening' : 'doctor.ports.peerNotListening', {
      port: peer.port,
    }),
  };
}

type MeshPortReachLite = {
  proto?: string;
  port?: number;
  range?: { begin?: number; end?: number };
  status?: string;
};

type MeshNodeLite = {
  id?: string;
  ports?: MeshPortReachLite[];
};

function formatReach(spec: MeshPortReachLite): string {
  const proto = spec.proto === 'udp' ? 'udp' : 'tcp';
  if (spec.range && Number.isInteger(spec.range.begin) && Number.isInteger(spec.range.end)) {
    return `${spec.range.begin}-${spec.range.end}/${proto}`;
  }
  if (spec.port != null) return `${spec.port}/${proto}`;
  return '';
}

function asNodeList(body: unknown): MeshNodeLite[] {
  if (!body || typeof body !== 'object' || !('nodes' in body)) return [];
  const nodes = (body as { nodes: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((row): row is MeshNodeLite => Boolean(row) && typeof row === 'object');
}

async function readSelfNodeId(base: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const res = await fetchImpl(`${base}/api/auth/mode`, {
      signal: AbortSignal.timeout(MESH_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { nodeId?: unknown };
    return typeof body.nodeId === 'string' && body.nodeId ? body.nodeId : null;
  } catch {
    return null;
  }
}

function pickSelfNode(nodes: MeshNodeLite[], selfId: string | null): MeshNodeLite | null {
  if (!selfId) return null;
  return nodes.find((row) => row.id === selfId) ?? null;
}

export async function meshSelfBlockedPortChecks(input: {
  host: string;
  port: string;
  fetchImpl?: FetchLike;
  cookieHeader?: string;
}): Promise<DoctorCheck[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = formatHttpEndpoint(rewriteWildcardBindHost(input.host), input.port);
  try {
    const headers: Record<string, string> = {};
    if (input.cookieHeader) headers.cookie = input.cookieHeader;
    const nodesRes = await fetchImpl(`${base}/api/mesh/nodes`, {
      headers,
      signal: AbortSignal.timeout(MESH_FETCH_TIMEOUT_MS),
    });
    if (!nodesRes.ok) return [];
    const nodes = asNodeList(await nodesRes.json());
    const self = pickSelfNode(nodes, await readSelfNodeId(base, fetchImpl));
    const blocked = (self?.ports ?? []).filter((item) => item.status === 'blocked');
    const list = blocked.map(formatReach).filter(Boolean).join(', ');
    if (!list) return [];
    return [
      {
        id: 'ports.blocked',
        level: 'warn',
        message: t('doctor.ports.blocked', { list }),
      },
    ];
  } catch {
    return [];
  }
}
