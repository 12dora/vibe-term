// 设备页头部的两枚可见性徽标（设计 §4「可见性」）：
//   1. 浏览器 ↔ node 的承载（primary / direct）与 RTT；
//   2. entry ↔ node 的到达路径（lan / relay / 不可达）。
// `self` 时两枚都不显示（浏览器直接连的就是 entry 自己，没有第二跳）。
// 点击展开 ICE 诊断浮层——F3-1 之前诊断值恒为 null，浮层显示占位说明。

import { SELF_NODE_ID } from '@tmex/api-client';
import { cn } from '@tmex/ui';
import { Activity, Route } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDirectDiagnostics, useNodeReach } from './direct-diagnostics';

function Badge({
  icon: Icon,
  label,
  tone,
  onClick,
  testId,
}: {
  icon: typeof Route;
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
  const reach = useNodeReach(nodeId);
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

  const pathLabel =
    diagnostics.path === 'direct' ? t('nodes.badge.direct') : t('nodes.badge.primary');
  const rttLabel =
    diagnostics.rtt == null ? t('nodes.badge.rttUnknown') : `${Math.round(diagnostics.rtt)}ms`;
  const reachLabel =
    reach === 'lan'
      ? t('nodes.reach.lan')
      : reach === 'relay'
        ? t('nodes.reach.relay')
        : t('nodes.reach.none');

  return (
    <div
      ref={containerRef}
      className="relative flex items-center gap-1"
      data-testid="device-node-badges"
    >
      <Badge
        icon={Activity}
        label={`${pathLabel} · ${rttLabel}`}
        tone={diagnostics.path === 'direct' ? 'ok' : 'muted'}
        onClick={() => setOpen((value) => !value)}
        testId="badge-browser-to-node"
      />
      <Badge
        icon={Route}
        label={reachLabel}
        tone={reach ? 'ok' : 'muted'}
        testId="badge-entry-to-node"
      />
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-border bg-popover p-2 text-xs shadow-md animate-in fade-in-0 zoom-in-95 duration-(--tmex-motion-fast) ease-out motion-reduce:animate-none"
          data-testid="ice-diagnostics"
        >
          <div className="mb-1 font-semibold">{t('nodes.badge.iceTitle')}</div>
          <dl className="space-y-0.5">
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
      )}
    </div>
  );
}

function DiagnosticRow({ label, value }: { label: string; value?: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono">{value ?? t('nodes.badge.unknown')}</dd>
    </div>
  );
}
