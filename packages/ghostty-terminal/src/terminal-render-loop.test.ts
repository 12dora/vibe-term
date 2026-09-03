import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TerminalRenderLoop } from './terminal-render-loop';

let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
let callbacks: Map<number, FrameRequestCallback>;
let cancelled: number[];
let nextFrameId: number;

beforeEach(() => {
  previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  callbacks = new Map();
  cancelled = [];
  nextFrameId = 1;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const frame = nextFrameId++;
    callbacks.set(frame, callback);
    return frame;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((frame: number) => {
    cancelled.push(frame);
    callbacks.delete(frame);
  }) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
});

function runFrames(): void {
  const pending = [...callbacks.values()];
  callbacks.clear();
  for (const callback of pending) callback(0);
}

describe('TerminalRenderLoop suspension', () => {
  test('cancels a pending frame and rejects schedules until resumed', () => {
    const paints: boolean[] = [];
    const loop = new TerminalRenderLoop(() => paints.push(loop.consumeForceFull()));

    loop.schedule();
    expect(callbacks.size).toBe(1);
    expect(loop.setRenderSuspended(true)).toBe(true);
    expect(callbacks.size).toBe(0);
    expect(cancelled).toEqual([1]);

    loop.requestFullRepaint();
    loop.schedule();
    expect(callbacks.size).toBe(0);
    expect(loop.setRenderSuspended(true)).toBe(false);

    expect(loop.setRenderSuspended(false)).toBe(true);
    loop.schedule();
    runFrames();

    expect(paints).toEqual([true]);
  });
});
