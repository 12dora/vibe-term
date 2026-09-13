// 本机卡「网络」段的端口行：一行标签 + 一串端口条目，灯的 title / aria-label 直接说清三态，
// 不再单摆一句图例。灯三态：绿=open、红=blocked、灰=unknown 或尚未探测（无 reach 行）。

import { TONE_CLASS } from '@/lib/tone';
import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { type PortSpec, formatPortSpec } from '@vibeterm/shared/net';
import { Button } from '@vibeterm/ui/button';
import { Loader2 } from 'lucide-react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Row } from './copy-feedback';
import {
  type MeshPortReach,
  type MeshPortReachStatus,
  parsePortReachList,
  reachForSpec,
} from './port-reach';

const PORT_DOT_TONE: Record<MeshPortReachStatus, keyof typeof TONE_CLASS.dot> = {
  open: 'ok',
  blocked: 'blocked',
  unknown: 'muted',
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
  selfNodeId,
  probe = defaultProbe,
  busy: busyOverride,
  error: errorOverride,
}: {
  plan: PortSpec[];
  /** 测试注入；缺省读 mesh 列表里的 self 行。 */
  reach?: MeshPortReach[] | null;
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
    <Row label={t('nodes.ports.label')} testId="local-machine-ports">
      {/* 「重新检测」钉在值列右端，不进端口列表的流：否则端口多起来它会被挤到下一行。 */}
      <div className="flex w-full items-start justify-between gap-2">
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {plan.map((spec) => (
            <PortItem key={spec.purpose} spec={spec} ports={ports} />
          ))}
        </ul>
        {selfId && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0"
            disabled={probing}
            onClick={() => void recheck()}
            data-testid="local-machine-ports-recheck"
          >
            {probing && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('nodes.ports.recheck')}
          </Button>
        )}
      </div>
      {probeError && (
        <p className="w-full text-destructive" data-testid="local-machine-ports-error">
          {probeError}
        </p>
      )}
    </Row>
  );
}

function PortItem({ spec, ports }: { spec: PortSpec; ports: MeshPortReach[] | undefined }) {
  const { t } = useTranslation();
  const reach = reachForSpec(ports, spec);
  const status = reach?.status ?? 'unknown';
  return (
    <li
      className="flex items-center gap-1.5 text-xs"
      data-testid={`local-port-${spec.purpose}`}
      data-port-status={status}
    >
      <PortIndicator purpose={spec.purpose} reach={reach} status={status} />
      <code className="font-mono">{formatPortSpec(spec)}</code>
      <span className="text-muted-foreground">{t(`ports.purpose.${spec.purpose}`)}</span>
    </li>
  );
}

function PortIndicator({
  purpose,
  reach,
  status,
}: {
  purpose: PortSpec['purpose'];
  reach: MeshPortReach | undefined;
  status: MeshPortReachStatus;
}) {
  const { t } = useTranslation();
  // 图例撤掉之后，灯的三态只能靠自己说清楚：title 给鼠标，aria-label 给读屏。
  const title = reach ? portDotTitle(t, reach) : t('localMachine.ports.notProbedTitle');
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${TONE_CLASS.dot[PORT_DOT_TONE[status]]}`}
      title={title}
      role="img"
      aria-label={title}
      data-testid={`local-port-dot-${purpose}`}
      data-status={status}
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
