// 用法: bun run packages/shared/bench/legacy-snapshot-diff.bench.ts
// 对比 legacy 快照 diff 的两种实现：全量克隆 + 线性查找 vs 目标 window 直查 + 写时复制。

import type { StateSnapshotPayload, TmuxWindow } from '../src/index';
import { SOURCE_ENTITY_PANE, SOURCE_FIELD_TITLE } from '../src/ws-borsh/canonical-state';
import {
  type LegacyStateSnapshotDiff,
  applyLegacyStateSnapshotDiff,
} from '../src/ws-borsh/state-snapshot-diff';
import { referenceApply } from '../src/ws-borsh/test-fakes';

function snapshot(windowCount: number, panesPerWindow: number): StateSnapshotPayload {
  const windows: TmuxWindow[] = Array.from({ length: windowCount }, (_unused, windowIndex) => ({
    id: `@${windowIndex}`,
    name: `w${windowIndex}`,
    index: windowIndex,
    active: windowIndex === 0,
    layout: 'aaaa,80x24,0,0,1',
    panes: Array.from({ length: panesPerWindow }, (_ignored, paneIndex) => ({
      id: `%${windowIndex}-${paneIndex}`,
      windowId: `@${windowIndex}`,
      index: paneIndex,
      active: paneIndex === 0,
      width: 80,
      height: 24,
      title: 'zsh',
      currentPath: '/Users/dev/code',
      currentCommand: 'zsh',
    })),
  }));
  return { deviceId: 'device-a', session: { id: '$1', name: 'work', windows } };
}

function paneDiff(windowCount: number, count: number): LegacyStateSnapshotDiff {
  return {
    removals: [],
    upserts: Array.from({ length: count }, (_unused, index) => ({
      entityKind: SOURCE_ENTITY_PANE,
      nativeId: `%${index % windowCount}-0`,
      parentKind: SOURCE_ENTITY_WINDOW,
      parentId: `@${index % windowCount}`,
      fields: [[SOURCE_FIELD_TITLE, `title-${index}`] as [number, string]],
    })),
  };
}

function measure(label: string, iterations: number, run: () => void): number {
  for (let index = 0; index < Math.min(iterations, 200); index += 1) run();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsed = performance.now() - start;
  const perOp = (elapsed * 1000) / iterations;
  console.log(`${label.padEnd(46)} ${perOp.toFixed(3)} µs/op  (${elapsed.toFixed(1)} ms)`);
  return perOp;
}

function compare(windowCount: number, panesPerWindow: number, upserts: number): void {
  const base = snapshot(windowCount, panesPerWindow);
  const diff = paneDiff(windowCount, upserts);
  const iterations = 5_000;
  console.log(
    `\n${windowCount} windows x ${panesPerWindow} panes, ${upserts} pane upserts, ${iterations} iterations`
  );
  const before = measure('  clone-all + findIndex (before)', iterations, () => {
    referenceApply(base, diff);
  });
  const after = measure('  destination probe + copy-on-write (after)', iterations, () => {
    applyLegacyStateSnapshotDiff(base, diff);
  });
  console.log(`  speedup ${(before / after).toFixed(1)}x`);
}

compare(4, 4, 1);
compare(10, 8, 2);
compare(20, 10, 5);
compare(40, 16, 10);
