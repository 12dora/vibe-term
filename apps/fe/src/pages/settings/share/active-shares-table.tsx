// 进行中的分享：一行一条，复制链接与终止两个动作。终止走二次确认（对方会立刻断开）。

import type { ShareRecord } from '@tmex/shared/share';
import { Button } from '@tmex/ui/button';
import { Copy, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WideTableScroll, stickyActionColumn } from '../components/wide-table';
import { useCopyToClipboard } from '../nodes/copy-feedback';
import {
  absoluteTimeText,
  expiresText,
  originHostText,
  relativePastText,
  shareTerminalText,
} from './share-format';
import { EmptyRow, Td, Th, TimeCell } from './table-parts';

export interface ActiveSharesTableProps {
  shares: ShareRecord[];
  now: number;
  busyShareId: string | null;
  deviceName: (deviceId: string) => string | null;
  onStop: (record: ShareRecord) => void;
}

export function ActiveSharesTable({
  shares,
  now,
  busyShareId,
  deviceName,
  onStop,
}: ActiveSharesTableProps) {
  const { t } = useTranslation();
  return (
    <WideTableScroll>
      <table className="w-full min-w-[52rem] text-xs" data-testid="share-active-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <Th>{t('settings.share.active.columns.name')}</Th>
            <Th>{t('settings.share.active.columns.terminal')}</Th>
            <Th>{t('settings.share.active.columns.viewers')}</Th>
            <Th>{t('settings.share.active.columns.created')}</Th>
            <Th>{t('settings.share.active.columns.expires')}</Th>
            <Th>{t('settings.share.active.columns.address')}</Th>
            <Th className={stickyActionColumn}>{t('settings.share.active.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {shares.map((share) => (
            <ActiveRow
              key={share.id}
              share={share}
              now={now}
              busy={busyShareId === share.id}
              deviceName={deviceName(share.deviceId)}
              onStop={onStop}
            />
          ))}
          {shares.length === 0 && (
            <EmptyRow colSpan={7} testId="share-active-empty">
              {t('settings.share.active.empty')}
            </EmptyRow>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

function ActiveRow({
  share,
  now,
  busy,
  deviceName,
  onStop,
}: {
  share: ShareRecord;
  now: number;
  busy: boolean;
  deviceName: string | null;
  onStop: (record: ShareRecord) => void;
}) {
  const { t } = useTranslation();
  return (
    <tr
      className="border-b border-border/60 last:border-0 hover:bg-muted/40"
      data-testid={`share-active-row-${share.id}`}
    >
      <Td className="max-w-48 truncate">{share.name}</Td>
      <Td className="max-w-56 truncate" title={shareTerminalText(share, deviceName)}>
        {shareTerminalText(share, deviceName)}
      </Td>
      <Td testId={`share-viewers-${share.id}`}>{share.viewers}</Td>
      <Td>
        <TimeCell
          text={relativePastText(t, share.createdAt, now)}
          title={absoluteTimeText(share.createdAt)}
        />
      </Td>
      <Td>
        <TimeCell
          text={expiresText(t, share.expiresAt, now)}
          title={absoluteTimeText(share.expiresAt)}
        />
      </Td>
      <Td className="max-w-56 truncate" title={share.url}>
        {originHostText(share.origin)}
      </Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-center gap-1">
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
      </Td>
    </tr>
  );
}

function CopyLinkButton({ share }: { share: ShareRecord }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyToClipboard(share.url);
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={copy}
      data-testid={`share-copy-${share.id}`}
    >
      <Copy />
      {copied ? t('settings.share.active.linkCopied') : t('settings.share.active.copyLink')}
      <output className="sr-only" aria-live="polite">
        {copied ? t('settings.share.active.linkCopied') : ''}
      </output>
    </Button>
  );
}
