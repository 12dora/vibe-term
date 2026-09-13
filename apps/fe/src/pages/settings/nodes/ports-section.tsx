// 本机卡「网络」段的端口行：一行标签 + 一串端口条目，灯的 title / aria-label 直接说清三态，
// 不再单摆一句图例。灯三态：绿=open、红=blocked、灰=unknown 或尚未探测（无 reach 行）。

import { TONE_CLASS } from '@/lib/tone';
import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { type PortSpec, coalesceTurnSpecs, formatPortSpec } from '@vibeterm/shared/net';
import { Button } from '@vibeterm/ui/button';
import { Loader2 } from 'lucide-react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Row } from './copy-feedback';
import {
  type MeshPortReach,
  type MeshPortReachStatus,
  parsePortReachList,
  reachForPlanSpec,
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
  // TURN 的控制口与中继段是连着的一段，分两行摆只是把同一件事说两遍。
  const specs = coalesceTurnSpecs(plan);
  return (
    <Row label={t('nodes.ports.label')} testId="local-machine-ports">
      {/* 宽屏「重新检测」钉在值列右端，不进端口列表的流；窄屏端口一行一条，按钮退到列表下方。 */}
      <div className="flex w-full flex-col items-stretch gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
        <ul className="flex min-w-0 flex-col gap-1 sm:flex-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1">
          {specs.map((spec) => (
            <PortItem key={spec.purpose} spec={spec} ports={ports} />
          ))}
        </ul>
        {selfId && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="-my-1 shrink-0 self-end sm:self-auto"
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
  const reach = reachForPlanSpec(ports, spec);
  const status = reach?.status ?? 'unknown';
  return (
    <li
      className="flex min-w-0 items-center gap-1.5 text-xs"
      data-testid={`local-port-${spec.purpose}`}
      data-port-status={status}
    >
      <PortIndicator purpose={spec.purpose} reach={reach} status={status} />
      <code className="whitespace-nowrap font-mono">{formatPortSpec(spec)}</code>
      <span className="min-w-0 truncate text-muted-foreground">
        {t(`ports.purpose.${spec.purpose}`)}
      </span>
      {/* 只有出问题的那一档配一句可见文字：红点本身对色觉障碍与触屏用户是读不出来的。 */}
      {status === 'blocked' && (
        <span className="text-destructive" data-testid={`local-port-blocked-${spec.purpose}`}>
          {t('localMachine.ports.blocked')}
        </span>
      )}
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
