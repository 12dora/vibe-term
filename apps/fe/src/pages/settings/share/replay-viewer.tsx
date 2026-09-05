// 日志回放窗：只读终端 + 时间轴。日志分页拉齐，边拉边能看；输入只在下方的标记条里出现。

import type { ShareRecord } from '@tmex/shared/share';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { ReplayControls, ReplayInputTicker } from './replay-controls';
import { buildReplayTimeline } from './replay-timeline';
import { useReplayLog } from './use-replay-log';
import { useReplayPlayer } from './use-replay-player';
import { useReplayTerminal } from './use-replay-terminal';

export interface ReplayViewerProps {
  /** 要回放的分享；`null` 即关闭。 */
  share: ShareRecord | null;
  onClose: () => void;
}

export function ReplayViewer({ share, onClose }: ReplayViewerProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={share !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl" data-testid="share-replay-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings.share.replay.title')}</DialogTitle>
          <DialogDescription>{share?.name ?? ''}</DialogDescription>
        </DialogHeader>
        {share && <ReplayBody shareId={share.id} />}
      </DialogContent>
    </Dialog>
  );
}

function ReplayBody({ shareId }: { shareId: string }) {
  const { t } = useTranslation();
  const mountRef = useRef<HTMLDivElement>(null);
  const log = useReplayLog(shareId);
  const terminal = useReplayTerminal(mountRef);
  const timeline = useMemo(() => buildReplayTimeline(log.entries), [log.entries]);
  const player = useReplayPlayer(timeline, terminal.handle, terminal.ready);

  const empty = !log.loading && log.error === null && log.entries.length === 0;

  return (
    <div className="flex flex-col gap-2" data-testid="share-replay-body">
      {log.error && (
        <Notice tone="error" testId="share-replay-error">
          {t('settings.share.replay.loadFailed', { message: log.error })}
        </Notice>
      )}
      {log.truncated && (
        <Notice tone="warning" testId="share-replay-truncated">
          {t('settings.share.replay.truncatedNotice')}
        </Notice>
      )}

      <div
        className="relative h-[22rem] w-full overflow-hidden rounded-md border"
        style={{ backgroundColor: terminal.background }}
      >
        <div ref={mountRef} className="absolute inset-0" data-testid="share-replay-mount" />
        {(log.loading || !terminal.ready) && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            {t('settings.share.replay.loading', {
              loaded: log.entries.length,
              total: Math.max(log.total, log.entries.length),
            })}
          </div>
        )}
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            {t('settings.share.replay.empty')}
          </div>
        )}
      </div>

      <ReplayControls
        player={player}
        panes={timeline.panes}
        disabled={timeline.panes.length === 0 || !terminal.ready}
      />
      <ReplayInputTicker player={player} />
    </div>
  );
}
