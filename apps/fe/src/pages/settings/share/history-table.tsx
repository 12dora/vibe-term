// 已结束的分享：回放日志与删除记录。删除会连日志一起删，走二次确认。

import type { ShareRecord } from '@tmex/shared/share';
import { Button } from '@tmex/ui/button';
import { Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WideTableScroll, stickyActionColumn } from '../components/wide-table';
import {
  absoluteTimeText,
  durationText,
  endReasonText,
  logSizeText,
  relativePastText,
  shareTerminalText,
} from './share-format';
import { EmptyRow, Td, Th, TimeCell } from './table-parts';

export interface HistoryTableProps {
  shares: ShareRecord[];
  now: number;
  busyShareId: string | null;
  deviceName: (deviceId: string) => string | null;
  onReplay: (record: ShareRecord) => void;
  onDelete: (record: ShareRecord) => void;
}

export function ShareHistoryTable({
  shares,
  now,
  busyShareId,
  deviceName,
  onReplay,
  onDelete,
}: HistoryTableProps) {
  const { t } = useTranslation();
  return (
    <WideTableScroll>
      <table className="w-full min-w-[48rem] text-xs" data-testid="share-history-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <Th>{t('settings.share.history.columns.name')}</Th>
            <Th>{t('settings.share.history.columns.terminal')}</Th>
            <Th>{t('settings.share.history.columns.ended')}</Th>
            <Th>{t('settings.share.history.columns.duration')}</Th>
            <Th>{t('settings.share.history.columns.log')}</Th>
            <Th className={stickyActionColumn}>{t('settings.share.history.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {shares.map((share) => (
            <HistoryRow
              key={share.id}
              share={share}
              now={now}
              busy={busyShareId === share.id}
              deviceName={deviceName(share.deviceId)}
              onReplay={onReplay}
              onDelete={onDelete}
            />
          ))}
          {shares.length === 0 && (
            <EmptyRow colSpan={6} testId="share-history-empty">
              {t('settings.share.history.empty')}
            </EmptyRow>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

function HistoryRow({
  share,
  now,
  busy,
  deviceName,
  onReplay,
  onDelete,
}: {
  share: ShareRecord;
  now: number;
  busy: boolean;
  deviceName: string | null;
  onReplay: (record: ShareRecord) => void;
  onDelete: (record: ShareRecord) => void;
}) {
  const { t } = useTranslation();
  const hasLog = share.logBytes > 0;
  return (
    <tr
      className="border-b border-border/60 last:border-0 hover:bg-muted/40"
      data-testid={`share-history-row-${share.id}`}
    >
      <Td className="max-w-48 truncate">{share.name}</Td>
      <Td className="max-w-56 truncate" title={shareTerminalText(share, deviceName)}>
        {shareTerminalText(share, deviceName)}
      </Td>
      <Td>
        <span className="flex items-center gap-1.5">
          {endReasonText(t, share.endReason)}
          <span className="text-muted-foreground">
            <TimeCell
              text={relativePastText(t, share.endedAt ?? share.createdAt, now)}
              title={absoluteTimeText(share.endedAt)}
            />
          </span>
        </span>
      </Td>
      <Td>{durationText(share, now)}</Td>
      <Td testId={`share-log-size-${share.id}`}>{logSizeText(t, share)}</Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!hasLog}
            onClick={() => onReplay(share)}
            data-testid={`share-replay-${share.id}`}
          >
            <Play />
            {t('settings.share.history.replay')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() => onDelete(share)}
            data-testid={`share-delete-${share.id}`}
          >
            <Trash2 />
            {t('common.delete')}
          </Button>
        </div>
      </Td>
    </tr>
  );
}
