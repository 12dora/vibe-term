// 节点详情里的端口表：初始值来自行上的 `ports`（或 mesh 列表里的同名字段），
// 「重新检测」打 `POST /api/mesh/nodes/:id/ports/probe`。旧网关没有该字段时整块不出现。

import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { useCallback, useState } from 'react';
import { type MeshPortReach, parsePortReachList } from '../port-reach';

export type ProbeNodePorts = (nodeId: string) => Promise<{ ports: unknown[] }>;

const defaultProbe: ProbeNodePorts = (nodeId) => defaultAuthApi.probeNodePorts(nodeId);

export function useNodePorts(
  nodeId: string,
  initial: MeshPortReach[] | undefined,
  probe: ProbeNodePorts = defaultProbe
) {
  const [ports, setPorts] = useState<MeshPortReach[] | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenId, setSeenId] = useState(nodeId);
  if (seenId !== nodeId) {
    setSeenId(nodeId);
    setPorts(initial);
    setError(null);
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
