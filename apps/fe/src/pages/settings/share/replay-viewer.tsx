// 日志回放窗：只读终端 + 时间轴。日志分页拉齐，边拉边能看；输入只在下方的标记条里出现。

import type { ShareRecord } from '@vibeterm/shared/share';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Loader2 } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { ReplayControls, ReplayInputTicker } from './replay-controls';
import { buildReplayTimeline } from './replay-timeline';
import { useReplayFit } from './use-replay-fit';
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
      <DialogContent className="sm:max-w-6xl" data-testid="share-replay-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings.share.replay.title')}</DialogTitle>
          <DialogDescription>{share?.name ?? ''}</DialogDescription>
        </DialogHeader>
        {share && <ReplayBody shareId={share.id} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 回放窗：固定高度的外框裁剪，滚动条由 widget 内部的平移视口提供。
 * 宽屏上给到 44rem，窄录像才有放大的余地；同时按视口高度封顶，免得控制条被挤出屏幕。
 */
export function ReplayTerminalFrame({
  children,
  loading,
  empty,
  loadingLabel,
  emptyLabel,
  frameRef,
}: {
  children: ReactNode;
  loading: boolean;
  empty: boolean;
  loadingLabel: string;
  emptyLabel: string;
  frameRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={frameRef}
      className="relative h-[22rem] max-h-[calc(100dvh-15rem)] w-full overflow-hidden rounded-md border sm:h-[44rem]"
    >
      {children}
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          {loadingLabel}
        </div>
      ) : null}
      {empty ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : null}
    </div>
  );
}

export function ReplayBody({ shareId }: { shareId: string }) {
  const { t } = useTranslation();
  const log = useReplayLog(shareId);
  const fit = useReplayFit();
  const terminal = useReplayTerminal(fit.fontSize);
  const timeline = useMemo(() => buildReplayTimeline(log.entries), [log.entries]);
  const player = useReplayPlayer(timeline, terminal.handle, terminal.ready, terminal.generation);

  // 录像网格决定字号，字号又要在终端建面时给出：先渲染，网格到了再回灌。
  const setFitGrid = fit.setGrid;
  const playerGrid = player.grid;
  useEffect(() => {
    setFitGrid(playerGrid);
  }, [setFitGrid, playerGrid]);

  const empty = !log.loading && log.errorKey === null && log.entries.length === 0;

  return (
    <div className="flex flex-col gap-2" data-testid="share-replay-body">
      {log.errorKey && (
        <Notice tone="error" testId="share-replay-error">
          {t('settings.share.replay.loadFailed', { message: t(log.errorKey) })}
        </Notice>
      )}
      {log.truncated && (
        <Notice tone="warning" testId="share-replay-truncated">
          {t('settings.share.replay.truncatedNotice')}
        </Notice>
      )}

      <ReplayTerminalFrame
        frameRef={fit.frameRef}
        // 改字号会重建终端：只在首次就绪前显示加载态，之后重建只留外框衬底，不闪遮罩。
        loading={log.loading || !terminal.booted}
        empty={empty}
        loadingLabel={t('settings.share.replay.loading', {
          loaded: log.entries.length,
          total: Math.max(log.total, log.entries.length),
        })}
        emptyLabel={t('settings.share.replay.empty')}
      >
        {terminal.widget}
      </ReplayTerminalFrame>

      <ReplayControls
        player={player}
        panes={timeline.panes}
        disabled={timeline.panes.length === 0 || !terminal.ready}
      />
      <ReplayInputTicker player={player} />
    </div>
  );
}
