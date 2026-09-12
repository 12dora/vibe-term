// 本机卡「入站端口」：角色计划 + 本机 self 行上的可达点。缺探测结果时点是「未知」，不算警告。

import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes';
import { type PortPurpose, type PortSpec, formatPortSpec } from '@vibeterm/shared/net';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type MeshPortReach,
  type MeshPortReachStatus,
  parsePortReachList,
  reachForPurpose,
} from './port-reach';

const DOT_CLASS: Record<MeshPortReachStatus, string> = {
  open: 'bg-emerald-500',
  blocked: 'bg-destructive',
  unknown: 'bg-muted-foreground/40',
};

export function PortsSection({
  plan,
  reach,
}: {
  plan: PortSpec[];
  /** 测试注入；缺省读 mesh 列表里的 self 行。 */
  reach?: MeshPortReach[] | null;
}) {
  const { t } = useTranslation();
  const live = useSelfNodePorts();
  const ports = reach !== undefined ? (reach ?? undefined) : live;
  if (plan.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="local-machine-ports">
      <span className="text-xs font-medium">{t('localMachine.ports.title')}</span>
      <ul className="flex flex-col gap-1">
        {plan.map((spec) => (
          <PortRow key={spec.purpose} spec={spec} ports={ports} />
        ))}
      </ul>
    </div>
  );
}

function PortRow({ spec, ports }: { spec: PortSpec; ports: MeshPortReach[] | undefined }) {
  const { t } = useTranslation();
  const status = reachForPurpose(ports, spec.purpose as PortPurpose)?.status ?? 'unknown';
  return (
    <li
      className="flex items-center gap-2 text-xs"
      data-testid={`local-port-${spec.purpose}`}
      data-port-status={status}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[status]}`}
        title={t(`nodes.ports.status.${status}`)}
        data-testid={`local-port-dot-${spec.purpose}`}
        aria-hidden
      />
      <code className="font-mono">{formatPortSpec(spec)}</code>
      <span className="text-muted-foreground">{t(`ports.purpose.${spec.purpose}`)}</span>
    </li>
  );
}

function useSelfNodePorts(): MeshPortReach[] | undefined {
  const state = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const selfId = state.entryNodeId;
  if (!selfId) return undefined;
  const mesh = state.nodes.find((node) => node.id === selfId);
  return parsePortReachList((mesh as { ports?: unknown } | undefined)?.ports);
}
