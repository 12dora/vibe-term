// 设备页头部的链路徽标（设计 §4「可见性」）：一枚徽标说清「源主机到终端有多远」。
// 数字是整条链路的往返：浏览器 ↔ 拥有该设备的 node（那条 Gateway WS 的心跳中位数，已含
// entry 转发 / peer link / 中继每一跳）加上 node ↔ tmux 的宿主一跳（网关按 DEVICE_LATENCY
// 下发，旧节点测不到）。标签仍写这条链路怎么走：直连 / 局域网 / 公网 / 中转 / 本机。
// 点击展开诊断浮层：先按跳拆开数字，再给这条链路的现场——走中转就说清中转地址与未直连的
// 原因，ICE 明细只在真的有 WebRTC 候选对时才列，避免一整屏「未知」。

import { TONE_CLASS } from '@/lib/tone';
import { SELF_NODE_ID } from '@vibeterm/api-client';
import { DIRECT_FAILURE_CODES } from '@vibeterm/api-client/auth/index';
import type { DirectFailureCode, MeshNodeDirectFailure } from '@vibeterm/api-client/auth/index';
import { cn } from '@vibeterm/ui';
import type { DirectDiagnostics, DirectIceDiagnostics } from '@vibeterm/ws-client/direct/types';
import { Activity } from 'lucide-react';
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePopoverPlacement } from './device-node-badges-placement';
import {
  type NodeLatency,
  type NodeLink,
  useDirectDiagnostics,
  useNodeLatency,
  useNodeLink,
} from './direct-diagnostics';
import {
  type LinkBadgeDescriptor,
  type LinkDetailKind,
  finiteRtt,
  formatLinkBadgeLabel,
  freshHostHop,
  hostHopExpiryDelayMs,
  linkDetailKind,
  reachLabelKey,
  relayPresenceLabel,
  resolveLinkBadge,
  totalLatencyMs,
  transportLabel,
} from './link-badge';
import { refreshMeshNodes } from './mesh-nodes';
import type { PopoverBox } from './popover-clamp';

export interface DiagnosticRowSpec {
  labelKey: string;
  /** 直接展示的原始值（地址、状态串）。 */
  value?: string | null;
  /** 需要翻译的值；`value` 缺席时用它。 */
  valueKey?: string;
  valueParams?: Record<string, string | number>;
  /** 各自翻译后再拼接的值片段（候选对两端）；优先于 `value` / `valueKey`。 */
  valueParts?: DiagnosticValuePart[];
  mono?: boolean;
}

/** `key` 存在就翻译，否则原样展示 `text`。 */
export type DiagnosticValuePart = { key?: string; text?: string };

const PART_SEPARATOR = ' → ';

export function resolveRowValue(
  row: DiagnosticRowSpec,
  t: (key: string, params?: Record<string, string | number>) => string
): string | null {
  if (row.valueParts) {
    return row.valueParts
      .map((part) => (part.key ? t(part.key) : (part.text ?? '?')))
      .join(PART_SEPARATOR);
  }
  return row.value ?? (row.valueKey ? t(row.valueKey, row.valueParams) : null);
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

function msRow(labelKey: string, rttMs: number | null): DiagnosticRowSpec {
  const rtt = finiteRtt(rttMs);
  return rtt == null
    ? { labelKey, valueKey: 'nodes.badge.rttPending', mono: false }
    : { labelKey, value: `${Math.round(rtt)}ms` };
}

/** 浏览器 → node 这一跳：那条 Gateway WS 心跳最近几次的中位数。 */
function browserHopRow(latency: NodeLatency): DiagnosticRowSpec {
  const ms = finiteRtt(latency.browserToNodeMs);
  if (ms == null) {
    return { labelKey: 'nodes.badge.browserHop', valueKey: 'nodes.badge.rttPending', mono: false };
  }
  return {
    labelKey: 'nodes.badge.browserHop',
    valueKey: 'nodes.badge.hopMedian',
    valueParams: { ms: Math.round(ms) },
    mono: false,
  };
}

/** node → tmux 这一跳：网关自己测的，没播报能力的旧节点直接说「未测量」。 */
function hostHopRow(latency: NodeLatency, now: number): DiagnosticRowSpec {
  const labelKey = 'nodes.badge.hostHop';
  if (!latency.hostHopSupported) {
    return { labelKey, valueKey: 'nodes.badge.hopUnsupported', mono: false };
  }
  const sample = freshHostHop(latency, now);
  if (!sample) {
    // 播报过、但 45 s 没有新样本：说清是停了，继续写「测量中」等于骗人
    const key = latency.hostHop ? 'nodes.badge.hopStale' : 'nodes.badge.rttPending';
    return { labelKey, valueKey: key, mono: false };
  }
  const ms = finiteRtt(sample.rttMs);
  if (ms == null) {
    return { labelKey, valueKey: 'nodes.badge.rttPending', mono: false };
  }
  return {
    labelKey,
    valueKey: sample.hop === 'ssh' ? 'nodes.badge.hopSsh' : 'nodes.badge.hopLocal',
    valueParams: { ms: Math.round(ms) },
    mono: false,
  };
}

/** 最近一次样本：两段各自的最新原始样本相加；与合计一致时不重复出这一行。 */
function lastSampleRow(
  latency: NodeLatency,
  total: number | null,
  now: number
): DiagnosticRowSpec | null {
  const browserRaw = finiteRtt(latency.browserToNodeRawMs);
  if (browserRaw == null) return null;
  const raw = Math.round(browserRaw + (finiteRtt(freshHostHop(latency, now)?.rawMs ?? null) ?? 0));
  if (total !== null && raw === Math.round(total)) return null;
  return { labelKey: 'nodes.badge.lastSample', value: `${raw}ms` };
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

/** W3C 的连接 / ICE 状态枚举；不在表内的值（浏览器方言）原样展示。 */
const ICE_STATES = new Set([
  'new',
  'connecting',
  'connected',
  'disconnected',
  'failed',
  'closed',
  'checking',
  'completed',
]);

const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);

function statePart(state: string | null): DiagnosticValuePart | null {
  if (!state) return null;
  return ICE_STATES.has(state) ? { key: `nodes.badge.ice.${state}` } : { text: state };
}

function candidatePart(type: string | null): DiagnosticValuePart | null {
  if (!type) return null;
  return CANDIDATE_TYPES.has(type) ? { key: `nodes.badge.candidate.${type}` } : { text: type };
}

function partRow(labelKey: string, part: DiagnosticValuePart | null): DiagnosticRowSpec {
  if (!part) return { labelKey, value: null };
  return part.key ? { labelKey, valueKey: part.key, mono: false } : { labelKey, value: part.text };
}

/** 候选对保持 `本端 → 对端` 的形状，两端各自翻译；拿不到两端时退回原串。 */
function selectedPairRow(ice: DirectIceDiagnostics): DiagnosticRowSpec {
  const local = candidatePart(ice.localCandidateType);
  const remote = candidatePart(ice.remoteCandidateType);
  if (!local && !remote) return { labelKey: 'nodes.badge.selectedPair', value: ice.selectedPair };
  return {
    labelKey: 'nodes.badge.selectedPair',
    valueParts: [local ?? { text: '?' }, remote ?? { text: '?' }],
    mono: false,
  };
}

function iceRows(ice: DirectIceDiagnostics): DiagnosticRowSpec[] {
  return [
    partRow('nodes.badge.connectionState', statePart(ice.connectionState)),
    partRow('nodes.badge.iceState', statePart(ice.iceConnectionState)),
    partRow('nodes.badge.localCandidate', candidatePart(ice.localCandidateType)),
    partRow('nodes.badge.remoteCandidate', candidatePart(ice.remoteCandidateType)),
    selectedPairRow(ice),
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
  // 直连那一跳另有自己的读数：WebRTC 候选对的 RTT，与心跳测出来的是同一条路的两把尺子。
  // 候选对明细还没到（`getStats()` 首轮之前）不影响这行——RTT 有值就先给出来。
  if (kind === 'browser-direct') {
    const rtt = msRow('nodes.badge.rttRow', diagnostics.rtt);
    return diagnostics.ice ? [rtt, ...iceRows(diagnostics.ice)] : [rtt];
  }
  if (kind === 'dc' || kind === 'ws-secure') {
    return addressRow('nodes.badge.peerAddress', link.peerAddress);
  }
  if (kind === 'relay') {
    // 「中转地址」是 hub / 中继那一跳的对端地址；「在线于」说的是这台机器还能从哪几条中继摸到，
    // 两者不是一回事：前者解释当前这条路，后者解释还剩几条退路。
    const presence = relayPresenceLabel(link);
    return [
      ...addressRow('nodes.badge.relayVia', link.peerAddress),
      ...(presence ? [{ labelKey: 'nodes.badge.relayPresence', value: presence }] : []),
    ];
  }
  return [];
}

/**
 * 未直连的原因：ws / DataChannel 各一行。网关给了稳定失败码就按码翻译，
 * 旧网关（只有原文）保留等宽原文——那是给排查用的机器措辞，不该混进译文的字体里。
 */
export function directFailureRows(failure: MeshNodeDirectFailure | null): DiagnosticRowSpec[] {
  if (!failure) return [];
  const rows: DiagnosticRowSpec[] = [];
  if (failure.ws) {
    rows.push(
      failureRow('nodes.badge.directFailureWs', failure.ws, failure.wsCode, {
        ...(failure.wsParams?.url ? { url: failure.wsParams.url } : {}),
        ...(failure.wsParams?.seconds != null ? { seconds: failure.wsParams.seconds } : {}),
      })
    );
  }
  if (failure.dc) {
    const until = failure.dcParams?.until;
    rows.push(
      failureRow(
        'nodes.badge.directFailureDc',
        failure.dc,
        // 旧网关在永久禁拨时也发 breaker_cooling 却不带 until，照译会把 `{{until}}` 原样显示
        until == null && failure.dcCode === 'breaker_cooling' ? 'breaker_paused' : failure.dcCode,
        until == null ? {} : { until: formatUntil(until) }
      )
    );
  }
  return rows;
}

const KNOWN_FAILURE_CODES = new Set<string>(DIRECT_FAILURE_CODES);

function failureRow(
  labelKey: string,
  raw: string,
  code: DirectFailureCode | null | undefined,
  params: Record<string, string | number>
): DiagnosticRowSpec {
  if (!code || !KNOWN_FAILURE_CODES.has(code)) return { labelKey, value: raw };
  return { labelKey, valueKey: `nodes.badge.failure.${code}`, valueParams: params, mono: false };
}

/** 熔断解除时刻按本地时区显示时分，跨天的冷却本就不该发生，不必带日期。 */
function formatUntil(until: number): string {
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return String(until);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * 浮层的行。先按跳拆开徽标上的那个数字（浏览器 → node、node → tmux），再列这条链路的现场。
 * entry ↔ node 的 peer ping 不再是头条，但排查「慢在哪一跳」时仍要看，留作一行明细。
 */
export function buildLinkDiagnosticRows(input: {
  diagnostics: DirectDiagnostics;
  link: NodeLink;
  latency: NodeLatency;
  now: number;
  /** 本机：没有 entry ↔ node 那一跳，到达路径 / 承载 / peer ping 都不成立。 */
  isSelf?: boolean;
}): DiagnosticRowSpec[] {
  const { diagnostics, link, latency, now } = input;
  const rows: DiagnosticRowSpec[] = [browserHopRow(latency), hostHopRow(latency, now)];
  const lastSample = lastSampleRow(latency, totalLatencyMs(latency, now), now);
  if (lastSample) rows.push(lastSample);
  if (input.isSelf === true) return rows;

  const kind = linkDetailKind(diagnostics.path, link.transport);
  const transport = transportLabel(link);
  rows.unshift(
    { labelKey: 'nodes.badge.reachRow', valueKey: reachLabelKey(link.reach), mono: false },
    {
      labelKey: 'nodes.badge.transportRow',
      valueKey: transport?.key,
      valueParams: transport?.params,
      mono: false,
    }
  );
  rows.push(msRow('nodes.badge.peerLink', link.rttMs));
  // `linkSinceAt` 是 entry ↔ node 那条链路的建立时刻；浏览器直连另算一跳，手上没有它的时长，
  // 借用只会给出一个说不通的数字，索性不出这一行。
  const since = kind === 'browser-direct' ? null : sinceRow(link.linkSinceAt, now);
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
  tone: LinkBadgeDescriptor['tone'];
  onClick?: () => void;
  testId: string;
}) {
  const className = cn(
    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none',
    TONE_CLASS.badge[tone]
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
  /** 当前设备；路由还没给出时宿主一跳按未测量展示。 */
  deviceId?: string;
}

/** 浮层展开期间「已连接」时长的刷新节拍；收起时不留常驻定时器。 */
const SINCE_TICK_MS = 15_000;

/**
 * 徽标读时间的唯一入口。收起状态下**不做周期性 tick**：宿主一跳的过期时刻可以由这一帧的
 * 到达时刻（`receivedAt`，本地盖章）算出来，只在那一刻醒一次，改的正是那一次真正会变的渲染
 * 结果；新样本到来会带来新的 `receivedAt`，定时器随之重排。浮层展开时才按秒级需求跟一个
 * 节拍——「已连接」时长在那期间确实每刻都在变，而开着的浮层只有一个。
 */
function useLatencyClock(sample: NodeLatency['hostHop'], open: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const receivedAt = sample?.receivedAt ?? null;

  useEffect(() => {
    const delay = hostHopExpiryDelayMs(receivedAt, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [receivedAt]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), SINCE_TICK_MS);
    return () => clearInterval(timer);
  }, [open]);

  return now;
}

export function DeviceNodeBadges({ nodeId, deviceId }: DeviceNodeBadgesProps) {
  const { t } = useTranslation();
  const diagnostics = useDirectDiagnostics(nodeId);
  const link = useNodeLink(nodeId);
  const latency = useNodeLatency(nodeId, deviceId);
  const isSelf = nodeId === SELF_NODE_ID;
  const [open, setOpen] = useState(false);
  const now = useLatencyClock(latency.hostHop, open);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const placement = usePopoverPlacement(containerRef, open);

  useEffect(() => {
    if (!open) return;
    // 浮层 portal 到 body，不再是徽标的后代：判「点在外面」必须把卡片本身也算进来
    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || cardRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 展开时补一次 `/api/mesh/nodes`：链路现场（对端地址、建立时刻、未直连原因）只走 REST，
  // 上一次轮询可能已经是 30 秒前的了。
  useEffect(() => {
    if (open) void refreshMeshNodes();
  }, [open]);

  const badge = resolveLinkBadge({ path: diagnostics.path, link, latency, isSelf, now });

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
      {/* 量完才渲染：placement 决定 fixed 的坐标，先渲染会在 body 左上角闪一帧 */}
      {open &&
        placement &&
        createPortal(
          <NodeLinkDiagnostics
            diagnostics={diagnostics}
            link={link}
            latency={latency}
            isSelf={isSelf}
            now={now}
            placement={placement}
            cardRef={cardRef}
          />,
          document.body
        )}
    </div>
  );
}

/** 量过之后的 fixed 定位；`maxHeight` 配合卡片自己的滚动，保证整块留在可见视口里。 */
function popoverStyle(placement: PopoverBox): CSSProperties {
  return {
    left: `${placement.left}px`,
    ...(placement.top === null ? {} : { top: `${placement.top}px` }),
    ...(placement.bottom === null ? {} : { bottom: `${placement.bottom}px` }),
    width: `${placement.width}px`,
    maxHeight: `${placement.maxHeight}px`,
  };
}

export function NodeLinkDiagnostics({
  diagnostics,
  link,
  latency,
  isSelf = false,
  now = Date.now(),
  placement = null,
  cardRef,
}: {
  diagnostics: DirectDiagnostics;
  link: NodeLink;
  latency: NodeLatency;
  isSelf?: boolean;
  /** 计算「已连接」时长的基准时刻；浮层每次展开时现算，不自己走定时器。 */
  now?: number;
  /** 量过视口后的 fixed 定位；缺席时退回「贴徽标右对齐、固定 288px」的 absolute 老样子。 */
  placement?: PopoverBox | null;
  /** portal 之后判「点在外面」用得着卡片本身。 */
  cardRef?: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const rows = buildLinkDiagnosticRows({ diagnostics, link, latency, now, isSelf });
  const kind = isSelf ? 'none' : linkDetailKind(diagnostics.path, link.transport);
  const failures = kind === 'relay' ? directFailureRows(link.directFailure) : [];
  return (
    <div
      ref={cardRef}
      className={cn(
        'rounded-md border border-border bg-popover p-2 text-xs shadow-md animate-in fade-in-0 zoom-in-95 duration-(--vibeterm-motion-fast) ease-out motion-reduce:animate-none',
        placement
          ? 'fixed z-50 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]'
          : 'absolute right-0 top-full z-20 mt-1 w-72'
      )}
      style={placement ? popoverStyle(placement) : undefined}
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
  const value = resolveRowValue(row, (key, params) => t(key, params));
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{t(row.labelKey)}</dt>
      <dd className={cn('truncate', (row.mono ?? true) && 'font-mono')} title={value ?? undefined}>
        {value ?? t('nodes.badge.unknown')}
      </dd>
    </div>
  );
}
