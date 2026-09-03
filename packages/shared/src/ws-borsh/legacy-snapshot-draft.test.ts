// 写时复制草稿与「全量克隆 + 线性查找」旧实现的差分测试：随机快照 + 随机 diff 结果必须一致。

import { describe, expect, test } from 'bun:test';

import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_ENTITY_SESSION,
  SOURCE_ENTITY_WINDOW,
  SOURCE_FIELD_ACTIVE,
  SOURCE_FIELD_CUSTOM_NAME,
  SOURCE_FIELD_INDEX,
  SOURCE_FIELD_NAME,
  SOURCE_FIELD_TITLE,
  SOURCE_FIELD_WIDTH,
} from './canonical-state';
import {
  type LegacyMetadataEntityDiff,
  type LegacyStateSnapshotDiff,
  applyLegacyStateSnapshotDiff,
} from './state-snapshot-diff';
import { referenceApply } from './test-fakes';

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const WINDOW_IDS = ['@0', '@1', '@2'];
const PANE_IDS = ['%0', '%1', '%2', '%3'];
const SESSION_IDS = ['$1', '$2'];

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

function randomSnapshot(random: () => number): StateSnapshotPayload {
  const available = [...PANE_IDS];
  const windows: TmuxWindow[] = [];
  for (const id of WINDOW_IDS) {
    if (random() < 0.25) continue;
    const panes: TmuxPane[] = [];
    while (available.length > 0 && random() < 0.6) {
      const paneId = available.splice(Math.floor(random() * available.length), 1)[0];
      panes.push({
        id: paneId,
        windowId: id,
        index: panes.length,
        active: false,
        width: 80,
        height: 24,
        title: `t-${paneId}`,
      });
    }
    windows.push({ id, name: `w-${id}`, index: windows.length, active: false, panes });
  }
  if (random() < 0.1) return { deviceId: 'device-a', session: null };
  return { deviceId: 'device-a', session: { id: SESSION_IDS[0], name: 'work', windows } };
}

function randomFields(random: () => number): LegacyMetadataEntityDiff['fields'] {
  const candidates: LegacyMetadataEntityDiff['fields'] = [
    [SOURCE_FIELD_NAME, `n-${Math.floor(random() * 10)}`],
    [SOURCE_FIELD_INDEX, Math.floor(random() * 5)],
    [SOURCE_FIELD_ACTIVE, random() < 0.5],
    [SOURCE_FIELD_WIDTH, Math.floor(random() * 200)],
    [SOURCE_FIELD_TITLE, random() < 0.3 ? null : `title-${Math.floor(random() * 10)}`],
    [SOURCE_FIELD_CUSTOM_NAME, random() < 0.3 ? null : `custom-${Math.floor(random() * 10)}`],
  ];
  return candidates.filter(() => random() < 0.5);
}

function randomUpsert(random: () => number): LegacyMetadataEntityDiff {
  const kind = pick(random, [SOURCE_ENTITY_SESSION, SOURCE_ENTITY_WINDOW, SOURCE_ENTITY_PANE]);
  if (kind === SOURCE_ENTITY_SESSION) {
    return {
      entityKind: kind,
      nativeId: pick(random, SESSION_IDS),
      parentKind: null,
      parentId: null,
      fields: randomFields(random),
    };
  }
  if (kind === SOURCE_ENTITY_WINDOW) {
    return {
      entityKind: kind,
      nativeId: pick(random, WINDOW_IDS),
      parentKind: SOURCE_ENTITY_SESSION,
      parentId: SESSION_IDS[0],
      fields: randomFields(random),
    };
  }
  return {
    entityKind: kind,
    nativeId: pick(random, PANE_IDS),
    parentKind: SOURCE_ENTITY_WINDOW,
    parentId: random() < 0.1 ? null : pick(random, WINDOW_IDS),
    fields: randomFields(random),
  };
}

function randomDiff(random: () => number): LegacyStateSnapshotDiff {
  const removals: LegacyStateSnapshotDiff['removals'] = [];
  while (random() < 0.4) {
    const kind = pick(random, [SOURCE_ENTITY_SESSION, SOURCE_ENTITY_WINDOW, SOURCE_ENTITY_PANE]);
    const pool =
      kind === SOURCE_ENTITY_SESSION
        ? SESSION_IDS
        : kind === SOURCE_ENTITY_WINDOW
          ? WINDOW_IDS
          : PANE_IDS;
    removals.push({ entityKind: kind, nativeId: pick(random, pool) });
  }
  const upserts: LegacyMetadataEntityDiff[] = [];
  while (random() < 0.7) upserts.push(randomUpsert(random));
  return { upserts, removals };
}

describe('legacy snapshot draft', () => {
  test('对随机快照与随机 diff，结果与旧实现逐字段一致', () => {
    const random = createRandom(0x5eed);
    let sessionsProduced = 0;
    for (let round = 0; round < 500; round += 1) {
      const snapshot = randomSnapshot(random);
      const diff = randomDiff(random);
      const expected = referenceApply(structuredClone(snapshot), structuredClone(diff));
      const actual = applyLegacyStateSnapshotDiff(snapshot, diff);
      if (actual.session) sessionsProduced += 1;
      expect([round, actual]).toEqual([round, expected]);
    }
    expect(sessionsProduced).toBeGreaterThan(100);
  });

  test('连续应用多个 diff 时与旧实现保持一致', () => {
    const random = createRandom(0xc0ffee);
    let current = randomSnapshot(random);
    let reference = structuredClone(current);
    for (let round = 0; round < 200; round += 1) {
      const diff = randomDiff(random);
      reference = referenceApply(reference, structuredClone(diff));
      current = applyLegacyStateSnapshotDiff(current, diff);
      expect([round, current]).toEqual([round, reference]);
    }
  });
});
