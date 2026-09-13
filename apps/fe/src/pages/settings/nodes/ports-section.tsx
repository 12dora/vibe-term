// 本机卡入站端口：标题按本机角色说清「谁的口」。
// 灯三态：绿=open、红=blocked、灰=unknown 或尚未探测（无 reach 行）。

import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { type PortSpec, formatPortSpec } from '@vibeterm/shared/net';
import { Button } from '@vibeterm/ui/button';
import { Loader2 } from 'lucide-react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type MeshPortReach,
  type MeshPortReachStatus,
  localPortsTitleKey,
  parsePortReachList,
  reachForSpec,
} from './port-reach';

const DOT_CLASS: Record<MeshPortReachStatus, string> = {
  open: 'bg-emerald-500',
  blocked: 'bg-destructive',
  unknown: 'bg-muted-foreground/40',
};

export type ProbeNodePorts = (nodeId: string) => Promise<{ ports: unknown[] }>;

const defaultProbe: ProbeNodePorts = (nodeId) => defaultAuthApi.probeNodePorts(nodeId);

export async function runPortsProbe(
  nodeId: string,
  probe: ProbeNodePorts
): Promise<{ ok: true; ports: MeshPortReach[] } | { ok: false; error: string }> {
  try {
    const result = await probe(nodeId);
    return { ok: true, ports: parsePortReachList(result.ports) ?? [] };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function portDotTitle(t: (key: string) => string, reach: MeshPortReach): string {
  const status = t(`nodes.ports.status.${reach.status}`);
  if (reach.status !== 'blocked' || !reach.code) return status;
  return `${status} · ${t(`nodes.ports.code.${reach.code}`)}`;
}

export function PortsSection({
  plan,
  reach,
  localRole,
  selfNodeId,
  probe = defaultProbe,
  busy: busyOverride,
  error: errorOverride,
}: {
  plan: PortSpec[];
  /** 测试注入；缺省读 mesh 列表里的 self 行。 */
  reach?: MeshPortReach[] | null;
  localRole?: string | null;
  selfNodeId?: string | null;
  probe?: ProbeNodePorts;
  busy?: boolean;
  error?: string | null;
}) {
  const { t } = useTranslation();
  const self = useSelfNode();
  const selfId = selfNodeId || self.id;
  const live = self.ports;
  const { busy, error, override, recheck } = useLocalPortsProbe(selfId, probe);
  const ports = override ?? (reach !== undefined ? (reach ?? undefined) : live);
  const probing = busyOverride ?? busy;
  const probeError = errorOverride ?? error;
  if (plan.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="local-machine-ports">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t(localPortsTitleKey(localRole))}</span>
        {selfId && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={probing}
            onClick={() => void recheck()}
            data-testid="local-machine-ports-recheck"
          >
            {probing && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('nodes.ports.recheck')}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="local-machine-ports-legend">
        {t('localMachine.ports.legend')}
      </p>
      <ul className="flex flex-col gap-1">
        {plan.map((spec) => (
          <PortRow key={spec.purpose} spec={spec} ports={ports} />
        ))}
      </ul>
      {probeError && (
        <p className="text-[11px] text-destructive" data-testid="local-machine-ports-error">
          {probeError}
        </p>
      )}
    </div>
  );
}

function PortRow({ spec, ports }: { spec: PortSpec; ports: MeshPortReach[] | undefined }) {
  const { t } = useTranslation();
  const reach = reachForSpec(ports, spec);
  const status = reach?.status ?? 'unknown';
  return (
    <li
      className="flex items-center gap-2 text-xs"
      data-testid={`local-port-${spec.purpose}`}
      data-port-status={status}
    >
      <PortIndicator spec={spec} reach={reach} status={status} />
      <code className="font-mono">{formatPortSpec(spec)}</code>
      <span className="text-muted-foreground">{t(`ports.purpose.${spec.purpose}`)}</span>
    </li>
  );
}

function PortIndicator({
  spec,
  reach,
  status,
}: {
  spec: PortSpec;
  reach: MeshPortReach | undefined;
  status: MeshPortReachStatus;
}) {
  const { t } = useTranslation();
  const title = reach ? portDotTitle(t, reach) : t('localMachine.ports.notProbedTitle');
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[status]}`}
      title={title}
      data-testid={`local-port-dot-${spec.purpose}`}
      data-status={status}
      aria-hidden
    />
  );
}

function useLocalPortsProbe(selfId: string | null, probe: ProbeNodePorts) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<MeshPortReach[] | undefined>(undefined);
  const recheck = useCallback(async () => {
    if (!selfId) return;
    setBusy(true);
    setError(null);
    const result = await runPortsProbe(selfId, probe);
    if (result.ok) setOverride(result.ports);
    else setError(result.error);
    setBusy(false);
  }, [selfId, probe]);
  return { busy, error, override, recheck };
}

function useSelfNode(): { id: string | null; ports: MeshPortReach[] | undefined } {
  const state = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const id = state.entryNodeId;
  if (!id) return { id: null, ports: undefined };
  const mesh = state.nodes.find((node) => node.id === id);
  return { id, ports: parsePortReachList((mesh as { ports?: unknown } | undefined)?.ports) };
}
