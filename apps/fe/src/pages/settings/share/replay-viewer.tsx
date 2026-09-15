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
import { buildReplayTimeline, replayPaneEnvelope } from './replay-timeline';
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
      <DialogContent className="sm:max-w-[min(96vw,110rem)]" data-testid="share-replay-dialog">
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
 * 回放窗：外框就是「终端窗口」，终端把它铺满；溢出部分的滚动条由 widget 内部的平移视口提供。
 * 高度跟着视口走（留出标题 + 控制条 + 输入条的位置），窄屏至少 18rem。
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
      className="relative h-[max(18rem,calc(100dvh-17rem))] w-full overflow-hidden rounded-md border"
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
  const timeline = useMemo(() => buildReplayTimeline(log.entries), [log.entries]);
  // 开面尺寸取默认 pane 的包络（第一页日志就有），不等播放机推进到第一个 checkpoint。
  const initialGrid = useMemo(() => replayPaneEnvelope(timeline.panes[0]), [timeline]);
  const fit = useReplayFit({ initialGrid, logSettled: !log.loading });
  const terminal = useReplayTerminal(fit.fontSize, fit.minGrid);
  const player = useReplayPlayer(timeline, terminal.handle, terminal.ready, terminal.generation);

  // 换 pane / 日志又来一页：包络可能变大，字号与仿真网格都要跟着走。
  const setFitGrid = fit.setGrid;
  const paneEnvelope = useMemo(() => replayPaneEnvelope(player.pane), [player.pane]);
  useEffect(() => {
    setFitGrid(paneEnvelope);
  }, [setFitGrid, paneEnvelope]);

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
        // 遮罩一直盖到「适配后的那一台」就绪为止；之后换字号重建只留外框衬底，不再闪遮罩。
        loading={log.loading || !terminal.booted || fit.pending}
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
