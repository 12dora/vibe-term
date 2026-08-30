// 设备页头部的链路徽标（设计 §4「可见性」）：一枚徽标说清「现在这条链路怎么走、多快」。
// 浏览器直连（WebRTC）活着时以直连为准，否则用 entry ↔ node 的到达路径（局域网 / 公网 /
// 经 Hub 中转 / 不可达）。`self` 不显示——浏览器直接连的就是 entry 自己，没有第二跳。
// 点击展开诊断浮层：到达路径、承载，以及直连的 ICE 明细。

import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNodeReach, MeshNodeTransport } from '@tmex/api-client/auth/index';
import { cn } from '@tmex/ui';
import type { DirectCarrierPath, DirectDiagnostics } from '@tmex/ws-client/direct/types';
import { Activity } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type NodeLink, useDirectDiagnostics, useNodeLink } from './direct-diagnostics';

const REACH_LABEL_KEYS = {
  lan: 'nodes.reach.lan',
  wan: 'nodes.reach.wan',
  relay: 'nodes.reach.relay',
} as const;

const TRANSPORT_LABEL_KEYS = {
  'ws-secure': 'nodes.badge.transportWs',
  dc: 'nodes.badge.transportDc',
  relay: 'nodes.badge.transportRelay',
} as const;

export function reachLabelKey(reach: MeshNodeReach): string {
  return reach ? REACH_LABEL_KEYS[reach] : 'nodes.reach.none';
}

export function transportLabelKey(transport: MeshNodeTransport): string | null {
  return transport ? TRANSPORT_LABEL_KEYS[transport] : null;
}

export interface LinkBadgeDescriptor {
  labelKey: string;
  /** 展示用的往返毫秒数；未测得为 `null`，此时徽标不带延迟后缀。 */
  rttMs: number | null;
  tone: 'ok' | 'muted';
}

/**
 * 徽标取值。直连活着时 RTT 取 WebRTC `getStats()` 的候选对；否则取 entry ↔ node 的 peer
 * ping RTT。测不到就不带后缀——写「延迟未知」只会让人以为链路出了问题。
 */
export function resolveLinkBadge(input: {
  path: DirectCarrierPath;
  directRttMs: number | null;
  link: NodeLink;
}): LinkBadgeDescriptor {
  if (input.path === 'direct') {
    return { labelKey: 'nodes.badge.direct', rttMs: finiteRtt(input.directRttMs), tone: 'ok' };
  }
  const { reach, rttMs } = input.link;
  return {
    labelKey: reachLabelKey(reach),
    rttMs: finiteRtt(rttMs),
    tone: reach === 'lan' || reach === 'wan' ? 'ok' : 'muted',
  };
}

export function formatLinkBadgeLabel(label: string, rttMs: number | null): string {
  return rttMs == null ? label : `${label} · ${Math.round(rttMs)}ms`;
}

function finiteRtt(rttMs: number | null): number | null {
  return typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs : null;
}

function Badge({
  icon: Icon,
  label,
  tone,
  onClick,
  testId,
}: {
  icon: typeof Activity;
  label: string;
  tone: 'ok' | 'muted';
  onClick?: () => void;
  testId: string;
}) {
  const className = cn(
    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none',
    tone === 'ok'
      ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
      : 'border-border text-muted-foreground'
  );
  if (!onClick) {
    return (
      <span className={className} data-testid={testId}>
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} data-testid={testId}>
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export interface DeviceNodeBadgesProps {
  nodeId: string;
}

export function DeviceNodeBadges({ nodeId }: DeviceNodeBadgesProps) {
  const { t } = useTranslation();
  const diagnostics = useDirectDiagnostics(nodeId);
  const link = useNodeLink(nodeId);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  if (nodeId === SELF_NODE_ID) return null;

  const badge = resolveLinkBadge({ path: diagnostics.path, directRttMs: diagnostics.rtt, link });

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-1"
      data-testid="device-node-badges"
    >
      <Badge
        icon={Activity}
        label={formatLinkBadgeLabel(t(badge.labelKey), badge.rttMs)}
        tone={badge.tone}
        onClick={() => setOpen((value) => !value)}
        testId="badge-node-link"
      />
      {open && <NodeLinkDiagnostics diagnostics={diagnostics} link={link} />}
    </div>
  );
}

export function NodeLinkDiagnostics({
  diagnostics,
  link,
}: {
  diagnostics: DirectDiagnostics;
  link: NodeLink;
}) {
  const { t } = useTranslation();
  const transportKey = transportLabelKey(link.transport);
  return (
    <div
      className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-border bg-popover p-2 text-xs shadow-md animate-in fade-in-0 zoom-in-95 duration-(--tmex-motion-fast) ease-out motion-reduce:animate-none"
      data-testid="ice-diagnostics"
    >
      <div className="mb-1 font-semibold">{t('nodes.badge.iceTitle')}</div>
      <dl className="space-y-0.5">
        <DiagnosticRow
          label={t('nodes.badge.reachRow')}
          value={t(reachLabelKey(link.reach))}
          mono={false}
        />
        <DiagnosticRow
          label={t('nodes.badge.transportRow')}
          value={transportKey ? t(transportKey) : null}
          mono={false}
        />
        <DiagnosticRow
          label={t('nodes.badge.connectionState')}
          value={diagnostics.ice?.connectionState}
        />
        <DiagnosticRow
          label={t('nodes.badge.iceState')}
          value={diagnostics.ice?.iceConnectionState}
        />
        <DiagnosticRow
          label={t('nodes.badge.localCandidate')}
          value={diagnostics.ice?.localCandidateType}
        />
        <DiagnosticRow
          label={t('nodes.badge.remoteCandidate')}
          value={diagnostics.ice?.remoteCandidateType}
        />
        <DiagnosticRow
          label={t('nodes.badge.selectedPair')}
          value={diagnostics.ice?.selectedPair}
        />
      </dl>
      {!diagnostics.ice && (
        <p className="mt-1 text-muted-foreground">{t('nodes.badge.icePlaceholder')}</p>
      )}
    </div>
  );
}

function DiagnosticRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('truncate', mono && 'font-mono')}>{value ?? t('nodes.badge.unknown')}</dd>
    </div>
  );
}
