// 回放控制条：播放 / 暂停、倍速、进度条、时间，以及多 pane 时的 pane 选择。
// 下方是输入标记条——被分享人敲的键只在这里显示，不写进终端。

import { Button } from '@vibeterm/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ReplayScrubber } from './replay-scrubber';
import { formatReplayClock, formatReplayWallClock } from './replay-timeline';
import type { ReplayPlayer } from './use-replay-player';

export function ReplayControls({
  player,
  panes,
  disabled,
}: {
  player: ReplayPlayer;
  panes: readonly { paneId: string; bytes: number }[];
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5" data-testid="share-replay-controls">
      <ReplayScrubber
        startAt={player.startAt}
        currentMs={player.currentMs}
        durationMs={player.durationMs}
        disabled={disabled}
        language={i18n.language}
        onSeek={player.seek}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          disabled={disabled}
          aria-label={
            player.playing ? t('settings.share.replay.pause') : t('settings.share.replay.play')
          }
          onClick={player.toggle}
          data-testid="share-replay-toggle"
        >
          {player.playing ? <Pause /> : <Play />}
        </Button>

        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={player.cycleSpeed}
          data-testid="share-replay-speed"
        >
          {t('settings.share.replay.speedValue', { n: player.speed })}
        </Button>
        <ReplayClock player={player} language={i18n.language} />
        <ReplayGridBadge player={player} />
        {panes.length > 1 && (
          <Select
            value={player.paneId ?? ''}
            onValueChange={(next) => next && player.selectPane(String(next))}
          >
            <SelectTrigger size="sm" className="w-36" data-testid="share-replay-pane">
              <SelectValue>
                {t('settings.share.replay.paneValue', { id: shortPaneId(player.paneId) })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {panes.map((pane) => (
                <SelectItem key={pane.paneId} value={pane.paneId}>
                  {t('settings.share.replay.paneValue', { id: shortPaneId(pane.paneId) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}

/** 录制尺寸：录像的网格是被分享那一端的，与当前外框宽度无关，标出来才知道画面到哪为止。 */
function ReplayGridBadge({ player }: { player: ReplayPlayer }) {
  const { t } = useTranslation();
  const grid = player.grid;
  if (!grid) return null;
  const label = t('settings.share.replay.recordedSize');
  return (
    <span
      className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground tabular-nums"
      data-testid="share-replay-grid"
      title={label}
      aria-label={label}
    >
      {grid.cols}×{grid.rows}
    </span>
  );
}

function ReplayClock({ player, language }: { player: ReplayPlayer; language: string }) {
  const { t } = useTranslation();
  const wall = t('settings.share.replay.wallTime');
  return (
    <span className="tabular-nums text-xs text-muted-foreground">
      <span data-testid="share-replay-clock">
        {formatReplayClock(player.currentMs)} / {formatReplayClock(player.durationMs)}
      </span>
      <span className="mx-1.5 text-border">·</span>
      <span data-testid="share-replay-wall-clock" title={wall} aria-label={wall}>
        {formatReplayWallClock(player.startAt + player.currentMs, language)}
      </span>
    </span>
  );
}

/** pane id 是 tmux 的 `%12` 之类；去掉前缀只留数字，选择器窄一点。 */
function shortPaneId(paneId: string | null): string {
  if (paneId === null) return '';
  return paneId.startsWith('%') ? paneId.slice(1) : paneId;
}

export function ReplayInputTicker({ player }: { player: ReplayPlayer }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 overflow-hidden rounded-md bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground"
      data-testid="share-replay-inputs"
    >
      <span className="shrink-0">{t('settings.share.replay.input')}</span>
      <span className="min-w-0 flex-1 truncate font-mono">
        {player.inputs.length === 0
          ? t('settings.share.replay.inputEmpty')
          : player.inputs.map((marker) => marker.text).join(' ')}
      </span>
    </div>
  );
}
