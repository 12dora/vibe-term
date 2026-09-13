// 分享两张表在 sm 以下的版式：一条分享一张记录卡。
//
// 进行中那张表有八列、历史六列，390px 下动作列整列被裁在屏幕外，复制链接与终止都点不到。
// 卡片把名称 / 终端 / 时间摊成两条弱化信息行，动作留在卡底；testid 与表里逐个对齐。

import {
  RecordCard,
  RecordCardEmpty,
  RecordCardList,
  RecordCardMeta,
} from '@/components/record-card';
import { Button } from '@vibeterm/ui/button';
import { Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ActiveSharesTableProps } from './active-shares-table';
import type { HistoryTableProps } from './history-table';
import {
  absoluteTimeText,
  durationText,
  endReasonText,
  expiresText,
  logSizeText,
  originHostText,
  relativePastText,
  shareTerminalText,
} from './share-format';
import { CopyLinkButton, HistoryActions, SharePasswordMenu } from './share-row-parts';
import { type ShareRow, shareRowKey } from './share-rows';

export function ActiveSharesCardList({
  shares,
  now,
  busyRowKey,
  showNode,
  deviceName,
  onStop,
  onPasswordAction,
}: ActiveSharesTableProps) {
  const { t } = useTranslation();
  return (
    <RecordCardList testId="share-active-table">
      {shares.map((share) => {
        const busy = busyRowKey === shareRowKey(share);
        return (
          <RecordCard key={shareRowKey(share)} testId={`share-active-row-${share.id}`}>
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{share.name}</span>
              <SharePasswordMenu share={share} busy={busy} onPasswordAction={onPasswordAction} />
            </div>

            <RecordCardMeta>
              <span className="truncate" title={shareTerminalText(share, deviceName(share))}>
                {shareTerminalText(share, deviceName(share))}
              </span>
              {showNode && (
                <span data-testid={`share-node-${share.id}`} title={share.nodeName}>
                  {share.nodeName}
                </span>
              )}
            </RecordCardMeta>

            <RecordCardMeta>
              <span data-testid={`share-viewers-${share.id}`}>
                {t('settings.share.active.columns.viewers')} {share.viewers}
              </span>
              <span title={absoluteTimeText(share.createdAt)}>
                {relativePastText(t, share.createdAt, now)}
              </span>
              <span title={absoluteTimeText(share.expiresAt)}>
                {expiresText(t, share.expiresAt, now)}
              </span>
            </RecordCardMeta>

            {share.origin && (
              <span className="truncate text-[11px] text-muted-foreground" title={share.url}>
                {originHostText(share.origin)}
              </span>
            )}

            <div className="flex flex-wrap items-center gap-1">
              <CopyLinkButton share={share} />
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={busy}
                onClick={() => onStop(share)}
                data-testid={`share-stop-${share.id}`}
              >
                <Square />
                {t('settings.share.active.stop')}
              </Button>
            </div>
          </RecordCard>
        );
      })}
      {shares.length === 0 && (
        <RecordCardEmpty testId="share-active-empty">
          {t('settings.share.active.empty')}
        </RecordCardEmpty>
      )}
    </RecordCardList>
  );
}

export function ShareHistoryCardList({
  shares,
  now,
  busyRowKey,
  deviceName,
  onReplay,
  onDelete,
}: HistoryTableProps) {
  const { t } = useTranslation();
  return (
    <RecordCardList testId="share-history-table">
      {shares.map((share) => (
        <HistoryCard
          key={shareRowKey(share)}
          share={share}
          now={now}
          busy={busyRowKey === shareRowKey(share)}
          deviceName={deviceName(share)}
          onReplay={onReplay}
          onDelete={onDelete}
        />
      ))}
      {shares.length === 0 && (
        <RecordCardEmpty testId="share-history-empty">
          {t('settings.share.history.empty')}
        </RecordCardEmpty>
      )}
    </RecordCardList>
  );
}

function HistoryCard({
  share,
  now,
  busy,
  deviceName,
  onReplay,
  onDelete,
}: {
  share: ShareRow;
  now: number;
  busy: boolean;
  deviceName: string | null;
  onReplay: (row: ShareRow) => void;
  onDelete: (row: ShareRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <RecordCard testId={`share-history-row-${share.id}`}>
      <span className="truncate font-medium">{share.name}</span>

      <RecordCardMeta>
        <span className="truncate" title={shareTerminalText(share, deviceName)}>
          {shareTerminalText(share, deviceName)}
        </span>
        <span title={absoluteTimeText(share.endedAt)}>
          {endReasonText(t, share.endReason)}{' '}
          {relativePastText(t, share.endedAt ?? share.createdAt, now)}
        </span>
      </RecordCardMeta>

      <RecordCardMeta>
        <span>{durationText(share, now)}</span>
        <span data-testid={`share-log-size-${share.id}`}>{logSizeText(t, share)}</span>
      </RecordCardMeta>

      <div className="flex flex-wrap items-center gap-1">
        <HistoryActions share={share} busy={busy} onReplay={onReplay} onDelete={onDelete} />
      </div>
    </RecordCard>
  );
}
