// 设备页头部的链路徽标（设计 §4「可见性」）：一枚徽标说清「现在这条链路怎么走、多快」。
// 浏览器直连（WebRTC）活着时以直连为准，否则用 entry ↔ node 的到达路径（局域网 / 公网 /
// 中转 / 不可达）。`self` 不显示——浏览器直接连的就是 entry 自己，没有第二跳。
// 点击展开诊断浮层：明细按链路种类给，走中转就说清中转地址与未直连的原因，
// ICE 明细只在真的有 WebRTC 候选对时才列，避免一整屏「未知」。

import { SELF_NODE_ID } from '@tmex/api-client';
import type {
  MeshNodeDirectFailure,
  MeshNodeReach,
  MeshNodeTransport,
} from '@tmex/api-client/auth/index';
import { cn } from '@tmex/ui';
import type {
  DirectCarrierPath,
  DirectDiagnostics,
  DirectIceDiagnostics,
} from '@tmex/ws-client/direct/types';
import { Activity } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type NodeLink, useDirectDiagnostics, useNodeLink } from './direct-diagnostics';
import { refreshMeshNodes } from './mesh-nodes';

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

/**
 * 明细要按哪种链路来列。`browser-direct` 是浏览器 ↔ node 的 WebRTC，其余取 entry ↔ node
 * 的承载——两者是不同的两跳，只有前者手上有 ICE 明细。
 */
export type LinkDetailKind = 'browser-direct' | 'dc' | 'ws-secure' | 'relay' | 'none';

export function linkDetailKind(
  path: DirectCarrierPath,
  transport: MeshNodeTransport
): LinkDetailKind {
  if (path === 'direct') return 'browser-direct';
  if (transport === 'relay') return 'relay';
  if (transport === 'ws-secure') return 'ws-secure';
  if (transport === 'dc') return 'dc';
  return 'none';
}

export interface DiagnosticRowSpec {
  labelKey: string;
  /** 直接展示的原始值（地址、状态串）。 */
  value?: string | null;
  /** 需要翻译的值；`value` 缺席时用它。 */
  valueKey?: string;
  valueParams?: Record<string, string | number>;
  mono?: boolean;
}

/** 已连接时长：秒 → 分 → 时 → 天，只取最大的那一档。 */
export function formatLinkSince(elapsedMs: number): { key: string; value: number } | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return { key: 'nodes.badge.durationSeconds', value: seconds };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: 'nodes.badge.durationMinutes', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: 'nodes.badge.durationHours', value: hours };
  return { key: 'nodes.badge.durationDays', value: Math.floor(hours / 24) };
}

function rttRow(rttMs: number | null): DiagnosticRowSpec {
  const rtt = finiteRtt(rttMs);
  return rtt == null
    ? { labelKey: 'nodes.badge.rttRow', valueKey: 'nodes.badge.rttPending', mono: false }
    : { labelKey: 'nodes.badge.rttRow', value: `${Math.round(rtt)}ms` };
}

function sinceRow(linkSinceAt: number | null, now: number): DiagnosticRowSpec | null {
  if (linkSinceAt == null) return null;
  const since = formatLinkSince(now - linkSinceAt);
  if (!since) return null;
  return {
    labelKey: 'nodes.badge.since',
    valueKey: since.key,
    valueParams: { value: since.value },
    mono: false,
  };
}

function addressRow(labelKey: string, address: string | null): DiagnosticRowSpec[] {
  return address ? [{ labelKey, value: address }] : [];
}

function iceRows(ice: DirectIceDiagnostics): DiagnosticRowSpec[] {
  return [
    { labelKey: 'nodes.badge.connectionState', value: ice.connectionState },
    { labelKey: 'nodes.badge.iceState', value: ice.iceConnectionState },
    { labelKey: 'nodes.badge.localCandidate', value: ice.localCandidateType },
    { labelKey: 'nodes.badge.remoteCandidate', value: ice.remoteCandidateType },
    { labelKey: 'nodes.badge.selectedPair', value: ice.selectedPair },
  ];
}

/**
 * ICE 明细只属于「浏览器 ↔ node」这一跳：`diagnostics.ice` 描述的是浏览器发起的那次 WebRTC，
 * 与 entry ↔ node 的 `dc` 承载是两条不同的链路，混在一起会把别人的候选对说成这条链路的。
 */
function detailRows(
  kind: LinkDetailKind,
  diagnostics: DirectDiagnostics,
  link: NodeLink
): DiagnosticRowSpec[] {
  if (kind === 'browser-direct') return diagnostics.ice ? iceRows(diagnostics.ice) : [];
  if (kind === 'dc' || kind === 'ws-secure') {
    return addressRow('nodes.badge.peerAddress', link.peerAddress);
  }
  if (kind === 'relay') return addressRow('nodes.badge.relayVia', link.peerAddress);
  return [];
}

/** 未直连的原因：ws / DataChannel 各一行，原样展示 node 侧记下的那句话。 */
export function directFailureRows(failure: MeshNodeDirectFailure | null): DiagnosticRowSpec[] {
  if (!failure) return [];
  return [
    ...(failure.ws ? [{ labelKey: 'nodes.badge.directFailureWs', value: failure.ws }] : []),
    ...(failure.dc ? [{ labelKey: 'nodes.badge.directFailureDc', value: failure.dc }] : []),
  ];
}

export function buildLinkDiagnosticRows(input: {
  diagnostics: DirectDiagnostics;
  link: NodeLink;
  now: number;
}): DiagnosticRowSpec[] {
  const { diagnostics, link, now } = input;
  const kind = linkDetailKind(diagnostics.path, link.transport);
  const browserDirect = kind === 'browser-direct';
  const transportKey = transportLabelKey(link.transport);
  const rows: DiagnosticRowSpec[] = [
    { labelKey: 'nodes.badge.reachRow', valueKey: reachLabelKey(link.reach), mono: false },
    {
      labelKey: 'nodes.badge.transportRow',
      valueKey: transportKey ?? undefined,
      mono: false,
    },
    rttRow(browserDirect ? diagnostics.rtt : link.rttMs),
  ];
  // `linkSinceAt` 是 entry ↔ node 那条链路的建立时刻；浏览器直连另算一跳，手上没有它的时长，
  // 借用只会给出一个说不通的数字，索性不出这一行。
  const since = browserDirect ? null : sinceRow(link.linkSinceAt, now);
  if (since) rows.push(since);
  rows.push(...detailRows(kind, diagnostics, link));
  return rows;
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

  // 展开时补一次 `/api/mesh/nodes`：链路现场（对端地址、建立时刻、未直连原因）只走 REST，
  // 上一次轮询可能已经是 30 秒前的了。
  useEffect(() => {
    if (open) void refreshMeshNodes();
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
  now = Date.now(),
}: {
  diagnostics: DirectDiagnostics;
  link: NodeLink;
  /** 计算「已连接」时长的基准时刻；浮层每次展开时现算，不自己走定时器。 */
  now?: number;
}) {
  const { t } = useTranslation();
  const rows = buildLinkDiagnosticRows({ diagnostics, link, now });
  const kind = linkDetailKind(diagnostics.path, link.transport);
  const failures = kind === 'relay' ? directFailureRows(link.directFailure) : [];
  return (
    <div
      className="absolute right-0 top-full z-20 mt-1 w-72 rounded-md border border-border bg-popover p-2 text-xs shadow-md animate-in fade-in-0 zoom-in-95 duration-(--tmex-motion-fast) ease-out motion-reduce:animate-none"
      data-testid="ice-diagnostics"
    >
      <div className="mb-1 font-semibold">{t('nodes.badge.iceTitle')}</div>
      <dl className="space-y-0.5">
        {rows.map((row) => (
          <DiagnosticRow key={row.labelKey} row={row} />
        ))}
      </dl>
      {failures.length > 0 && (
        <>
          <div className="mt-2 mb-1 font-semibold">{t('nodes.badge.directFailureTitle')}</div>
          <dl className="space-y-0.5">
            {failures.map((row) => (
              <DiagnosticRow key={row.labelKey} row={row} />
            ))}
          </dl>
        </>
      )}
      {kind === 'browser-direct' && !diagnostics.ice && (
        <p className="mt-1 text-muted-foreground">{t('nodes.badge.icePlaceholder')}</p>
      )}
    </div>
  );
}

function DiagnosticRow({ row }: { row: DiagnosticRowSpec }) {
  const { t } = useTranslation();
  const value = row.value ?? (row.valueKey ? t(row.valueKey, row.valueParams) : null);
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{t(row.labelKey)}</dt>
      <dd
        className={cn('truncate', (row.mono ?? true) && 'font-mono')}
        title={value ?? undefined}
      >
        {value ?? t('nodes.badge.unknown')}
      </dd>
    </div>
  );
}
