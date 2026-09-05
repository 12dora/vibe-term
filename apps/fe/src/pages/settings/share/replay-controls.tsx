// 回放控制条：播放 / 暂停、倍速、进度条、时间，以及多 pane 时的 pane 选择。
// 下方是输入标记条——被分享人敲的键只在这里显示，不写进终端。

import { Button } from '@tmex/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatReplayClock } from './replay-timeline';
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
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="share-replay-controls">
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

      <input
        type="range"
        className="h-1.5 min-w-40 flex-1 cursor-pointer accent-primary"
        min={0}
        max={Math.max(1, player.durationMs)}
        step={100}
        value={Math.round(player.currentMs)}
        disabled={disabled}
        aria-label={t('settings.share.replay.seek')}
        onChange={(event) => player.seek(Number(event.target.value))}
        data-testid="share-replay-scrubber"
      />

      <span className="tabular-nums text-xs text-muted-foreground" data-testid="share-replay-clock">
        {formatReplayClock(player.currentMs)} / {formatReplayClock(player.durationMs)}
      </span>

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
