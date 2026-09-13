// 节点详情的只读信息区：状态 / REACH / 地址 / 最近在线走 buildNodeView，与表同一口径。

import { TONE_CLASS } from '@/lib/tone';
import type { NodeRow } from '@/node/mesh-nodes';
import { buildNodeView, useMinuteClock } from '@/node/node-view-model';
import { relayHostLabel, relayHostList } from '@/node/relay-extras';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../copy-feedback';
import { hubModeLabel } from '../uplink/hub-strip';

const TRANSPORT_KEYS: Record<string, string> = {
  'ws-secure': 'nodes.badge.transportWs',
  dc: 'nodes.badge.transportDc',
  relay: 'nodes.badge.transportRelay',
};

export interface NodeTransportText {
  key: string;
  params?: { host: string };
}

/**
 * 承载那半句。走中继且知道是哪台时写明中继主机名——多中继之后「中转」两个字已经分不清
 * 这条链路究竟经了谁。旧网关不下发 `viaRelay`，退回原来的「中转」。
 */
export function nodeTransportText(row: NodeRow): NodeTransportText | null {
  const key = row.transport ? TRANSPORT_KEYS[row.transport] : undefined;
  if (!key) return null;
  if (row.transport !== 'relay' || !row.viaRelay) return { key };
  return { key: 'nodes.badge.transportRelayVia', params: { host: relayHostLabel(row.viaRelay) } };
}

/** 「在线于」那一行的值；该对端一条中继都没在线（或旧网关）时为 `null`。 */
export function nodeRelayPresenceText(row: NodeRow): string | null {
  const urls = row.relayPresence ?? [];
  return urls.length > 0 ? relayHostList(urls) : null;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs">{children}</span>
    </div>
  );
}

/** 只读信息区。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function NodeDetailInfo({ row }: { row: NodeRow }) {
  const { t } = useTranslation();
  const now = useMinuteClock(row.lastSeenAt != null);
  const view = buildNodeView(row, t, now);
  const transport = nodeTransportText(row);
  const presence = nodeRelayPresenceText(row);
  return (
    <div className="flex flex-col gap-1.5" data-testid={`nodes-detail-info-${row.id}`}>
      <InfoRow label={t('nodes.detail.nodeId')}>
        <span className="flex items-center gap-1">
          <code className="rounded bg-muted/50 px-1.5 py-0.5 text-[11px]">
            {row.id.slice(0, 8)}
          </code>
          <CopyButton value={row.id} testId={`nodes-detail-id-${row.id}`} />
        </span>
      </InfoRow>
      <InfoRow label={t('nodes.columns.fingerprint')}>
        <code className="font-mono text-[11px] text-muted-foreground">{row.fingerprint}</code>
      </InfoRow>
      <InfoRow label={t('nodes.columns.address')}>
        <code
          className="font-mono text-[11px] text-muted-foreground"
          data-testid={`nodes-detail-address-${row.id}`}
        >
          {view.addressText}
        </code>
      </InfoRow>
      <InfoRow label={t('nodes.columns.version')}>{row.version ?? '—'}</InfoRow>
      <InfoRow label={t('nodes.columns.reach')}>
        {view.reachText}
        {transport?.params ? `｜${t(transport.key, transport.params)}` : ''}
      </InfoRow>
      {presence && (
        <InfoRow label={t('nodes.badge.relayPresence')}>
          <span data-testid={`nodes-detail-relay-presence-${row.id}`}>{presence}</span>
        </InfoRow>
      )}
      <InfoRow label={t('nodes.columns.lastSeen')}>
        <span
          title={row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : undefined}
          data-testid={`nodes-detail-last-seen-${row.id}`}
        >
          {view.lastSeenText}
        </span>
      </InfoRow>
      <InfoRow label={t('nodes.columns.status')}>
        <span className="flex flex-wrap items-center gap-1">
          <span className={TONE_CLASS.text[view.statusTone]}>{view.statusText}</span>
          {row.isSelf && <DetailTag>{t('nodes.self')}</DetailTag>}
          {row.isHub && <DetailTag>{hubModeLabel(t, row.hubMode ?? null)}</DetailTag>}
        </span>
      </InfoRow>
    </div>
  );
}

function DetailTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}
