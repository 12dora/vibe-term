// 节点详情里的端口表：初始值来自行上的 `ports`（或 mesh 列表里的同名字段），
// 「重新检测」打 `POST /api/mesh/nodes/:id/ports/probe`。旧网关没有该字段时整块不出现。
//
// 行刷新时按值同步，不能按数组引用比较：调用方每次 render 都会 `resolveNodePorts` 出新数组。

import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { useCallback, useState } from 'react';
import { type MeshPortReach, parsePortReachList } from '../port-reach';

export type ProbeNodePorts = (nodeId: string) => Promise<{ ports: unknown[] }>;

const defaultProbe: ProbeNodePorts = (nodeId) => defaultAuthApi.probeNodePorts(nodeId);

export function portsInitialSnapshot(initial: MeshPortReach[] | undefined): string {
  return JSON.stringify(initial ?? null);
}

export function nextPortsSync(
  nodeId: string,
  initial: MeshPortReach[] | undefined,
  seenId: string,
  seenSnapshot: string,
  busy: boolean
): {
  seenId: string;
  seenSnapshot: string;
  updatePorts: boolean;
  ports: MeshPortReach[] | undefined;
  resetError: boolean;
} | null {
  const snapshot = portsInitialSnapshot(initial);
  if (seenId === nodeId && seenSnapshot === snapshot) return null;
  const nodeChanged = seenId !== nodeId;
  return {
    seenId: nodeId,
    seenSnapshot: snapshot,
    updatePorts: nodeChanged || !busy,
    ports: initial,
    resetError: nodeChanged,
  };
}

export function useNodePorts(
  nodeId: string,
  initial: MeshPortReach[] | undefined,
  probe: ProbeNodePorts = defaultProbe
) {
  const [ports, setPorts] = useState<MeshPortReach[] | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenId, setSeenId] = useState(nodeId);
  const [seenSnapshot, setSeenSnapshot] = useState(() => portsInitialSnapshot(initial));
  const patch = nextPortsSync(nodeId, initial, seenId, seenSnapshot, busy);
  if (patch) {
    setSeenId(patch.seenId);
    setSeenSnapshot(patch.seenSnapshot);
    if (patch.updatePorts) setPorts(patch.ports);
    if (patch.resetError) setError(null);
  }

  const recheck = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await probe(nodeId);
      setPorts(parsePortReachList(result.ports) ?? []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [nodeId, probe]);

  return { ports, busy, error, recheck };
}
