// 流缺口账本与 select 取舍的纯逻辑。

import { describe, expect, test } from 'bun:test';
import { createPaneStreamGaps, resolveSelectPaneDecision } from './pane-stream-gaps';

const BASE = {
  paneId: '%1',
  warmRequested: false,
  targetGapped: false,
  inFlightPaneId: null as string | null,
};

describe('resolveSelectPaneDecision', () => {
  test('cold request stays cold and has nothing to clean up', () => {
    expect(resolveSelectPaneDecision(BASE)).toEqual({
      wantHistory: true,
      abandonPaneId: null,
      gapPaneId: null,
    });
  });

  test('warm request with no in-flight transaction skips history', () => {
    expect(resolveSelectPaneDecision({ ...BASE, warmRequested: true })).toEqual({
      wantHistory: false,
      abandonPaneId: null,
      gapPaneId: null,
    });
  });

  test('a gapped target is vetoed back to a cold select', () => {
    expect(resolveSelectPaneDecision({ ...BASE, warmRequested: true, targetGapped: true })).toEqual(
      { wantHistory: true, abandonPaneId: null, gapPaneId: null }
    );
  });

  test('another pane still in flight is abandoned and gapped, the target stays warm', () => {
    expect(
      resolveSelectPaneDecision({ ...BASE, warmRequested: true, inFlightPaneId: '%2' })
    ).toEqual({ wantHistory: false, abandonPaneId: '%2', gapPaneId: '%2' });
  });

  test('the target itself in flight forces a cold select so the new token owns the gate', () => {
    expect(
      resolveSelectPaneDecision({ ...BASE, warmRequested: true, inFlightPaneId: '%1' })
    ).toEqual({ wantHistory: true, abandonPaneId: null, gapPaneId: null });
  });

  test('a cold select over another in-flight pane still records that pane as gapped', () => {
    expect(resolveSelectPaneDecision({ ...BASE, inFlightPaneId: '%2' })).toEqual({
      wantHistory: true,
      abandonPaneId: '%2',
      gapPaneId: '%2',
    });
  });
});

const TOKEN_A = Uint8Array.from([1, 2, 3, 4]);
const TOKEN_B = Uint8Array.from([9, 9, 9, 9]);

describe('pane stream gaps ledger', () => {
  test('a repair clears the gap only after history commit AND live resume', () => {
    const gaps = createPaneStreamGaps();
    gaps.markGapped('dev-1', '%1');
    gaps.beginRepair('dev-1', '%1', TOKEN_A);

    // 只有 live-resume、没观察到 history 落地：不能算补上
    gaps.completeRepair('dev-1', TOKEN_A);
    expect(gaps.isGapped('dev-1', '%1')).toBe(true);

    gaps.noteHistoryCommitted('dev-1', TOKEN_A);
    gaps.completeRepair('dev-1', TOKEN_A);
    expect(gaps.isGapped('dev-1', '%1')).toBe(false);
  });

  test('a transaction that ends without a commit record keeps the gap', () => {
    const gaps = createPaneStreamGaps();
    gaps.markGapped('dev-1', '%1');
    gaps.beginRepair('dev-1', '%1', TOKEN_A);

    // 门控溢出：状态机跳过 reset/apply，事务照样正常摘除。
    // 观察点不会记 commit，所以缺口必须留着。
    gaps.completeRepair('dev-1', TOKEN_A);

    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
  });

  test('signals carrying another token are ignored', () => {
    const gaps = createPaneStreamGaps();
    gaps.markGapped('dev-1', '%1');
    gaps.beginRepair('dev-1', '%1', TOKEN_A);

    gaps.noteHistoryCommitted('dev-1', TOKEN_B);
    gaps.completeRepair('dev-1', TOKEN_B);

    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
  });

  test('an aborted repair keeps the gap', () => {
    const gaps = createPaneStreamGaps();
    gaps.markGapped('dev-1', '%1');
    gaps.beginRepair('dev-1', '%1', TOKEN_A);
    gaps.noteHistoryCommitted('dev-1', TOKEN_A);

    gaps.abortRepair('dev-1');
    gaps.completeRepair('dev-1', TOKEN_A);

    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
  });

  test('re-gapping a pane invalidates its pending repair', () => {
    const gaps = createPaneStreamGaps();
    gaps.markGapped('dev-1', '%1');
    gaps.beginRepair('dev-1', '%1', TOKEN_A);
    gaps.noteHistoryCommitted('dev-1', TOKEN_A);

    // 补洞还没落定就又被打断
    gaps.markGapped('dev-1', '%1');
    gaps.completeRepair('dev-1', TOKEN_A);

    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
  });

  test('markDeviceGapped covers every known pane and drops the pending repair', () => {
    const gaps = createPaneStreamGaps();
    gaps.beginRepair('dev-1', '%1', TOKEN_A);
    gaps.noteHistoryCommitted('dev-1', TOKEN_A);

    gaps.markDeviceGapped('dev-1', ['%1', '%2', '%3']);

    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
    expect(gaps.isGapped('dev-1', '%2')).toBe(true);
    expect(gaps.isGapped('dev-1', '%3')).toBe(true);
    gaps.completeRepair('dev-1', TOKEN_A);
    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
  });

  test('panes missing from the snapshot are pruned', () => {
    const gaps = createPaneStreamGaps();
    gaps.markGapped('dev-1', '%1');
    gaps.markGapped('dev-1', '%2');
    gaps.beginRepair('dev-1', '%2', TOKEN_A);
    gaps.noteHistoryCommitted('dev-1', TOKEN_A);

    gaps.retainLivePanes('dev-1', new Set(['%1']));

    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
    expect(gaps.isGapped('dev-1', '%2')).toBe(false);
    // %2 没了，它的补洞记录也不该留着去清别人的缺口
    gaps.completeRepair('dev-1', TOKEN_A);
    expect(gaps.isGapped('dev-1', '%1')).toBe(true);
  });

  test('resetDevice drops the whole ledger for that device only', () => {
    const gaps = createPaneStreamGaps();
    gaps.markGapped('dev-1', '%1');
    gaps.markGapped('dev-2', '%1');

    gaps.resetDevice('dev-1');

    expect(gaps.isGapped('dev-1', '%1')).toBe(false);
    expect(gaps.isGapped('dev-2', '%1')).toBe(true);
  });
});
