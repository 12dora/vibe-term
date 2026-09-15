// 回放的播放机：时间推进、跳转、倍速、pane 切换，以及把事件喂给终端。
// 纯计算（建索引、跳转计划、事件翻译）在 replay-timeline.ts，这里只做副作用与状态。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { concatBytes, decodeBase64, describeInputBase64 } from './replay-decode';
import {
  type ReplayGrid,
  type ReplayPane,
  type ReplaySpeed,
  type ReplayTimeline,
  clampReplayTime,
  collectReplayOps,
  findReplayPane,
  nextReplaySpeed,
  planReplaySeek,
  replayGridAt,
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
  /** 时间轴起点（epoch ms），墙钟 = startAt + currentMs。 */
  startAt: number;
  currentMs: number;
  durationMs: number;
  /** 当前时刻录像的行列数；没有任何 checkpoint/resize 时为 null。 */
  grid: ReplayGrid | null;
  playing: boolean;
  speed: ReplaySpeed;
  inputs: ReplayInputMarker[];
  toggle: () => void;
  cycleSpeed: () => void;
  seek: (ms: number) => void;
  selectPane: (paneId: string) => void;
}

export interface ReplaySeekApplyInput {
  pane: ReplayPane;
  targetMs: number;
  cursor: number;
  force: boolean;
  terminal: ReplayTerminalHandle;
  markerSeq?: number;
}

export interface ReplaySeekApplyResult {
  cursor: number;
  reset: boolean;
  markers: ReplayInputMarker[];
  nextMarkerSeq: number;
}

/** 把时间轴窗口落到终端：强制重建时从 checkpoint 起重放，否则从 cursor 接着写。 */
export function applyReplaySeek(input: ReplaySeekApplyInput): ReplaySeekApplyResult {
  const planCursor = input.force ? Number.POSITIVE_INFINITY : input.cursor;
  const plan = planReplaySeek(input.pane, input.targetMs, planCursor);
  if (plan.reset) input.terminal.reset();
  let markerSeq = input.markerSeq ?? 0;
  const markers: ReplayInputMarker[] = [];
  for (const op of collectReplayOps(input.pane, plan.fromIndex, plan.toIndex)) {
    // resize 条目只用来算包络与显示「录制尺寸」：真去 resize 仿真终端会触发 ghostty 的
    // reflow，把录像里那些按固定网格画的 TUI 画面搅乱，而回放没有应用能重绘它。
    if (op.kind === 'resize') continue;
    // 快照要在录制网格下写：它带着录制那一刻的 history 与绝对光标位置。
    if (op.kind === 'checkpoint') {
      input.terminal.writeCheckpoint(decodeBase64(op.data), { cols: op.cols, rows: op.rows });
      continue;
    }
    if (op.kind === 'write') input.terminal.write(concatBytes(op.chunks.map(decodeBase64)));
    else {
      markers.push({
        seq: markerSeq++,
        t: op.t,
        text: describeInputBase64(op.data),
      });
    }
  }
  return { cursor: plan.toIndex, reset: plan.reset, markers, nextMarkerSeq: markerSeq };
}

interface ReplayClockInput {
  playing: boolean;
  speed: ReplaySpeed;
  durationMs: number;
  timeRef: { current: number };
  apply: (target: number, force: boolean) => void;
  setCurrentMs: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
}

/** 播放时钟：raf 按倍速推进时间并喂终端，播到片尾自动停。 */
function useReplayClock(input: ReplayClockInput): void {
  const { playing, speed, durationMs, timeRef, apply, setCurrentMs, setPlaying } = input;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let shown = timeRef.current;
    const tick = (now: number) => {
      const next = timeRef.current + (now - last) * speed;
      last = now;
      const target = Math.min(next, durationMs);
      timeRef.current = target;
      apply(target, false);
      if (Math.abs(target - shown) >= CLOCK_STEP_MS || target >= durationMs) {
        shown = target;
        setCurrentMs(target);
      }
      if (target >= durationMs) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, apply, durationMs, timeRef, setCurrentMs, setPlaying]);
}

export function useReplayPlayer(
  timeline: ReplayTimeline,
  terminal: ReplayTerminalHandle,
  ready: boolean,
  /** 终端实例代次：改字号重建实例时 ready 可能来不及翻成 false，只看布尔值会漏掉重建。 */
  bootGeneration = 0
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
      const result = applyReplaySeek({
        pane: current,
        targetMs: target,
        cursor: cursorRef.current,
        force,
        terminal,
        markerSeq: markerSeqRef.current,
      });
      cursorRef.current = result.cursor;
      markerSeqRef.current = result.nextMarkerSeq;
      if (result.reset) setInputs(result.markers.slice(-INPUT_HISTORY));
      else if (result.markers.length > 0) {
        setInputs((prev) => [...prev, ...result.markers].slice(-INPUT_HISTORY));
      }
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

  // 终端就绪（含重建）/ 换 pane：清空重建，再快进到当前时刻。
  // 依赖只认 paneId：日志是一页页到的，pane 对象每页都换一个新的，
  // 按对象身份重跑会让整份录像每来一页就从头快进一遍。
  const paneKey = pane?.paneId ?? null;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  // 未就绪为 0，就绪后是实例代次：一个值同时表达「能写了」和「换了一台」。
  const bootKey = ready ? Math.max(1, bootGeneration) : 0;
  useEffect(() => {
    if (bootKey === 0 || paneKey === null) return;
    terminal.reset();
    cursorRef.current = 0;
    applyRef.current(timeRef.current, true);
  }, [bootKey, paneKey, terminal]);

  useReplayClock({
    playing,
    speed,
    durationMs: timeline.durationMs,
    timeRef,
    apply,
    setCurrentMs,
    setPlaying,
  });

  const grid = useMemo(() => (pane ? replayGridAt(pane, currentMs) : null), [pane, currentMs]);

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
    startAt: timeline.startAt,
    currentMs,
    durationMs: timeline.durationMs,
    grid,
    playing,
    speed,
    inputs,
    toggle,
    cycleSpeed: () => setSpeed((prev) => nextReplaySpeed(prev)),
    seek: (ms: number) => goTo(ms, false),
    selectPane: (next: string) => setPaneId(next),
  };
}
