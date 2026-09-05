// 回放的播放机：时间推进、跳转、倍速、pane 切换，以及把事件喂给终端。
// 纯计算（建索引、跳转计划、事件翻译）在 replay-timeline.ts，这里只做副作用与状态。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { concatBytes, decodeBase64, describeInputBase64 } from './replay-decode';
import {
  type ReplayPane,
  type ReplaySpeed,
  type ReplayTimeline,
  clampReplayTime,
  collectReplayOps,
  findReplayPane,
  nextReplaySpeed,
  planReplaySeek,
} from './replay-timeline';
import type { ReplayTerminalHandle } from './use-replay-terminal';

export interface ReplayInputMarker {
  seq: number;
  t: number;
  text: string;
}

const INPUT_HISTORY = 12;
/** 进度条不必逐帧重渲染：100 ms 一格足够顺滑。 */
const CLOCK_STEP_MS = 100;

export interface ReplayPlayer {
  pane: ReplayPane | null;
  paneId: string | null;
  currentMs: number;
  durationMs: number;
  playing: boolean;
  speed: ReplaySpeed;
  inputs: ReplayInputMarker[];
  toggle: () => void;
  cycleSpeed: () => void;
  seek: (ms: number) => void;
  selectPane: (paneId: string) => void;
}

export function useReplayPlayer(
  timeline: ReplayTimeline,
  terminal: ReplayTerminalHandle,
  ready: boolean
): ReplayPlayer {
  const [paneId, setPaneId] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [inputs, setInputs] = useState<ReplayInputMarker[]>([]);

  const pane = useMemo(() => findReplayPane(timeline, paneId), [timeline, paneId]);
  const paneRef = useRef<ReplayPane | null>(pane);
  paneRef.current = pane;
  const timeRef = useRef(0);
  const cursorRef = useRef(0);
  const markerSeqRef = useRef(0);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const apply = useCallback(
    (target: number, force: boolean) => {
      const current = paneRef.current;
      if (!current || !readyRef.current) return;
      const plan = planReplaySeek(
        current,
        target,
        force ? Number.POSITIVE_INFINITY : cursorRef.current
      );
      if (plan.reset) terminal.reset();
      const markers: ReplayInputMarker[] = [];
      for (const op of collectReplayOps(current, plan.fromIndex, plan.toIndex)) {
        if (op.kind === 'resize') terminal.resize(op.cols, op.rows);
        else if (op.kind === 'write') terminal.write(concatBytes(op.chunks.map(decodeBase64)));
        else
          markers.push({
            seq: markerSeqRef.current++,
            t: op.t,
            text: describeInputBase64(op.data),
          });
      }
      cursorRef.current = plan.toIndex;
      if (plan.reset) setInputs(markers.slice(-INPUT_HISTORY));
      else if (markers.length > 0) setInputs((prev) => [...prev, ...markers].slice(-INPUT_HISTORY));
    },
    [terminal]
  );

  const goTo = useCallback(
    (ms: number, force: boolean) => {
      const target = clampReplayTime(ms, timeline.durationMs);
      timeRef.current = target;
      setCurrentMs(target);
      apply(target, force);
    },
    [apply, timeline.durationMs]
  );

  // 终端就绪 / 换 pane：清空重建，再快进到当前时刻。
  // 依赖只认 paneId：日志是一页页到的，pane 对象每页都换一个新的，
  // 按对象身份重跑会让整份录像每来一页就从头快进一遍。
  const paneKey = pane?.paneId ?? null;
  useEffect(() => {
    if (!ready || paneKey === null) return;
    terminal.reset();
    cursorRef.current = 0;
    apply(timeRef.current, true);
  }, [ready, paneKey, apply, terminal]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let shown = timeRef.current;
    const tick = (now: number) => {
      const next = timeRef.current + (now - last) * speed;
      last = now;
      const end = timeline.durationMs;
      const target = Math.min(next, end);
      timeRef.current = target;
      apply(target, false);
      if (Math.abs(target - shown) >= CLOCK_STEP_MS || target >= end) {
        shown = target;
        setCurrentMs(target);
      }
      if (target >= end) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, apply, timeline.durationMs]);

  const toggle = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // 播到头再点播放：从头重来。
    if (timeRef.current >= timeline.durationMs) goTo(0, true);
    setPlaying(true);
  }, [playing, goTo, timeline.durationMs]);

  return {
    pane,
    paneId: pane?.paneId ?? null,
    currentMs,
    durationMs: timeline.durationMs,
    playing,
    speed,
    inputs,
    toggle,
    cycleSpeed: () => setSpeed((prev) => nextReplaySpeed(prev)),
    seek: (ms: number) => goTo(ms, false),
    selectPane: (next: string) => setPaneId(next),
  };
}
