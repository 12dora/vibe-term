// 回放时间轴：原生 range 负责拖动/键盘/触控，外面包刻度、起止墙钟和拖动预览。

import { cn } from '@vibeterm/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  REPLAY_PREVIEW_HIDE_MS,
  clampReplayPreviewX,
  formatReplayDate,
  formatReplayWallClock,
  planReplayMinorTicks,
  planReplayTicks,
  replayCrossesCalendarDay,
  replayPreviewRatio,
  replayScrubPositionToMs,
} from './replay-timeline';

export interface ReplayScrubberProps {
  startAt: number;
  currentMs: number;
  durationMs: number;
  disabled: boolean;
  language: string;
  onSeek: (ms: number) => void;
  className?: string;
}

const PREVIEW_LABEL_PX = 72;

type HideTimer = ReturnType<typeof setTimeout> | null;

function clearHideTimer(timerRef: { current: HideTimer }): void {
  if (timerRef.current === null) return;
  clearTimeout(timerRef.current);
  timerRef.current = null;
}

function useReplayScrubPreview(disabled: boolean) {
  const [previewMs, setPreviewMs] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const hoveringRef = useRef(false);
  const hideTimerRef = useRef<HideTimer>(null);

  const show = (ms: number) => {
    if (disabled) return;
    clearHideTimer(hideTimerRef);
    setPreviewMs(ms);
  };

  const scheduleHide = () => {
    clearHideTimer(hideTimerRef);
    hideTimerRef.current = setTimeout(() => {
      if (!draggingRef.current && !hoveringRef.current) setPreviewMs(null);
    }, REPLAY_PREVIEW_HIDE_MS);
  };

  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearHideTimer(hideTimerRef);
    };
  }, []);

  useEffect(() => {
    if (!disabled) return;
    draggingRef.current = false;
    hoveringRef.current = false;
    clearHideTimer(hideTimerRef);
    setPreviewMs(null);
  }, [disabled]);

  return { previewMs, width, trackRef, draggingRef, hoveringRef, show, scheduleHide };
}

export function ReplayPreviewLabel({
  epochMs,
  ratio,
  trackWidth,
  language,
  ariaLabel,
}: {
  epochMs: number;
  ratio: number;
  trackWidth: number;
  language: string;
  ariaLabel: string;
}) {
  const left = clampReplayPreviewX(ratio, trackWidth, PREVIEW_LABEL_PX);
  return (
    <output
      aria-label={ariaLabel}
      data-testid="share-replay-preview"
      className="pointer-events-none absolute top-0 z-20 -translate-x-1/2 rounded bg-foreground px-1.5 py-0.5 text-[10px] tabular-nums text-background"
      style={{ left }}
    >
      {formatReplayWallClock(epochMs, language)}
    </output>
  );
}

export function ReplayTickRail({
  startAt,
  durationMs,
  widthPx,
  language,
}: {
  startAt: number;
  durationMs: number;
  widthPx: number;
  language: string;
}) {
  const major = useMemo(() => planReplayTicks(durationMs, widthPx), [durationMs, widthPx]);
  const minor = useMemo(
    () => planReplayMinorTicks(durationMs, major.stepMs),
    [durationMs, major.stepMs]
  );
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 h-full"
      data-testid="share-replay-ticks"
      data-step-ms={major.stepMs}
    >
      {minor.map((ms) => (
        <span
          key={`m-${ms}`}
          data-testid="share-replay-tick-minor"
          className="absolute top-5 h-1 w-px bg-muted-foreground/30"
          style={{ left: `${replayPreviewRatio(ms, durationMs) * 100}%` }}
        />
      ))}
      {major.ticks.map((ms) => (
        <ReplayMajorTick
          key={ms}
          ms={ms}
          startAt={startAt}
          durationMs={durationMs}
          language={language}
        />
      ))}
    </div>
  );
}

function ReplayMajorTick({
  ms,
  startAt,
  durationMs,
  language,
}: {
  ms: number;
  startAt: number;
  durationMs: number;
  language: string;
}) {
  const edge = ms === 0 || ms === durationMs;
  return (
    <span
      data-testid="share-replay-tick"
      data-ms={ms}
      className="absolute top-5 -translate-x-1/2"
      style={{ left: `${replayPreviewRatio(ms, durationMs) * 100}%` }}
    >
      {!edge && (
        <span className="absolute bottom-full left-1/2 mb-0.5 -translate-x-1/2 whitespace-nowrap text-[9px] leading-none tabular-nums text-muted-foreground">
          {formatReplayWallClock(startAt + ms, language)}
        </span>
      )}
      <span className="block h-1.5 w-px bg-muted-foreground/70" />
    </span>
  );
}

/** 无 hook：测试可直接调用并驱动 onChange。 */
export function ReplayRangeInput({
  currentMs,
  durationMs,
  disabled,
  wallClock,
  seekLabel,
  onChange,
}: {
  currentMs: number;
  durationMs: number;
  disabled: boolean;
  wallClock: string;
  seekLabel: string;
  onChange: (ms: number) => void;
}) {
  return (
    <input
      type="range"
      className="absolute inset-x-0 top-2 z-10 h-6 w-full cursor-pointer appearance-none bg-transparent accent-primary disabled:cursor-not-allowed"
      min={0}
      max={durationMs}
      step={100}
      value={Math.round(currentMs)}
      disabled={disabled}
      aria-label={seekLabel}
      aria-valuetext={wallClock}
      onChange={(event) => onChange(Number(event.target.value))}
      data-testid="share-replay-scrubber"
    />
  );
}

export function ReplayRangeEnds({
  startAt,
  durationMs,
  language,
  startLabel,
  endLabel,
}: {
  startAt: number;
  durationMs: number;
  language: string;
  startLabel: string;
  endLabel: string;
}) {
  const endAt = startAt + Math.max(0, durationMs);
  const cross = replayCrossesCalendarDay(startAt, durationMs);
  return (
    <div className="mt-0.5 flex items-start justify-between gap-2 text-[10px] leading-tight tabular-nums text-muted-foreground">
      <span
        data-testid="share-replay-start-label"
        title={startLabel}
        className="flex min-w-0 flex-col"
      >
        <span>{formatReplayWallClock(startAt, language)}</span>
        {cross && (
          <span
            data-testid="share-replay-start-date"
            className="text-[9px] text-muted-foreground/80"
          >
            {formatReplayDate(startAt, language)}
          </span>
        )}
      </span>
      <span data-testid="share-replay-end-label" title={endLabel} className="shrink-0">
        {formatReplayWallClock(endAt, language)}
      </span>
    </div>
  );
}

function bindScrubHover(args: {
  disabled: boolean;
  durationMs: number;
  currentMs: number;
  draggingRef: { current: boolean };
  hoveringRef: { current: boolean };
  show: (ms: number) => void;
  scheduleHide: () => void;
}) {
  if (args.disabled) return {};
  return {
    onPointerDown: () => {
      args.draggingRef.current = true;
      args.show(args.currentMs);
    },
    onPointerUp: () => {
      args.draggingRef.current = false;
      args.scheduleHide();
    },
    onPointerCancel: () => {
      args.draggingRef.current = false;
      args.scheduleHide();
    },
    onMouseEnter: () => {
      args.hoveringRef.current = true;
    },
    onMouseMove: (event: { currentTarget: HTMLElement; clientX: number }) => {
      if (args.draggingRef.current) return;
      args.hoveringRef.current = true;
      const rect = event.currentTarget.getBoundingClientRect();
      args.show(replayScrubPositionToMs(event.clientX, rect, args.durationMs));
    },
    onMouseLeave: () => {
      args.hoveringRef.current = false;
      args.scheduleHide();
    },
  };
}

export function ReplayScrubber({
  startAt,
  currentMs,
  durationMs,
  disabled,
  language,
  onSeek,
  className,
}: ReplayScrubberProps) {
  const { t } = useTranslation();
  const preview = useReplayScrubPreview(disabled);
  const span = Math.max(1, durationMs);
  const ratio = replayPreviewRatio(preview.previewMs ?? currentMs, durationMs);
  const hover = bindScrubHover({
    disabled,
    durationMs,
    currentMs,
    draggingRef: preview.draggingRef,
    hoveringRef: preview.hoveringRef,
    show: preview.show,
    scheduleHide: preview.scheduleHide,
  });

  return (
    <fieldset
      className={cn('relative m-0 w-full min-w-0 select-none border-0 p-0', className)}
      data-testid="share-replay-timeline"
    >
      <legend className="sr-only">{t('settings.share.replay.timelineLabel')}</legend>
      <div ref={preview.trackRef} className="relative h-8 pt-4" {...hover}>
        {preview.previewMs !== null && (
          <ReplayPreviewLabel
            epochMs={startAt + preview.previewMs}
            ratio={ratio}
            trackWidth={preview.width}
            language={language}
            ariaLabel={t('settings.share.replay.previewTime')}
          />
        )}
        <ReplayTickRail
          startAt={startAt}
          durationMs={durationMs}
          widthPx={preview.width}
          language={language}
        />
        <div className="pointer-events-none absolute inset-x-0 top-5 h-1 rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary/70"
            style={{ width: `${replayPreviewRatio(currentMs, durationMs) * 100}%` }}
          />
        </div>
        <ReplayRangeInput
          currentMs={currentMs}
          durationMs={span}
          disabled={disabled}
          wallClock={formatReplayWallClock(startAt + currentMs, language)}
          seekLabel={t('settings.share.replay.seek')}
          onChange={(ms) => {
            onSeek(ms);
            preview.show(ms);
            if (!preview.draggingRef.current) preview.scheduleHide();
          }}
        />
      </div>
      <ReplayRangeEnds
        startAt={startAt}
        durationMs={durationMs}
        language={language}
        startLabel={t('settings.share.replay.startTime')}
        endLabel={t('settings.share.replay.endTime')}
      />
    </fieldset>
  );
}
