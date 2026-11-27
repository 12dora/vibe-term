import { describe, expect, test } from 'bun:test';
import { createPageActivityTracker } from './page-activity';
import {
  type ViewportClaim,
  bindViewportClaims,
  createViewportClaimSender,
  resolveViewportClaim,
} from './use-viewport-claims';

function harness() {
  const sent: Array<{ deviceId: string; paneId: string; claim: ViewportClaim }> = [];
  const sender = createViewportClaimSender((deviceId, paneId, claim) => {
    sent.push({ deviceId, paneId, claim });
  });
  return { sender, sent };
}

describe('createViewportClaimSender', () => {
  test('sends the first claim and swallows identical repeats', () => {
    const { sender, sent } = harness();

    sender.claim('dev-a', '%1', { cols: 100, rows: 30 }, true);
    sender.claim('dev-a', '%1', { cols: 100, rows: 30 }, true);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.claim).toEqual({ cols: 100, rows: 30, visible: true });
  });

  test('resends when geometry or visibility changes', () => {
    const { sender, sent } = harness();

    sender.claim('dev-a', '%1', { cols: 100, rows: 30 }, true);
    sender.claim('dev-a', '%1', { cols: 120, rows: 30 }, true);
    sender.claim('dev-a', '%1', { cols: 120, rows: 30 }, false);

    expect(sent.map((entry) => entry.claim)).toEqual([
      { cols: 100, rows: 30, visible: true },
      { cols: 120, rows: 30, visible: true },
      { cols: 120, rows: 30, visible: false },
    ]);
  });

  test('claims are tracked per pane', () => {
    const { sender, sent } = harness();

    sender.claim('dev-a', '%1', { cols: 100, rows: 30 }, true);
    sender.claim('dev-a', '%2', { cols: 100, rows: 30 }, true);

    expect(sent.map((entry) => entry.paneId)).toEqual(['%1', '%2']);
  });

  test('release withdraws the last visible claim exactly once', () => {
    const { sender, sent } = harness();

    sender.claim('dev-a', '%1', { cols: 100, rows: 30 }, true);
    sender.release('dev-a', '%1');
    sender.release('dev-a', '%1');

    expect(sent).toHaveLength(2);
    expect(sent[1]?.claim).toEqual({ cols: 100, rows: 30, visible: false });
  });

  test('release is a no-op for a pane that never claimed', () => {
    const { sender, sent } = harness();

    sender.release('dev-a', '%1');

    expect(sent).toHaveLength(0);
  });

  test('forget makes the next identical claim go out again (reconnect)', () => {
    const { sender, sent } = harness();

    sender.claim('dev-a', '%1', { cols: 100, rows: 30 }, true);
    sender.forget('dev-a', '%1');
    sender.claim('dev-a', '%1', { cols: 100, rows: 30 }, true);

    expect(sent).toHaveLength(2);
  });

  test('ignores empty ids', () => {
    const { sender, sent } = harness();

    sender.claim('', '%1', { cols: 100, rows: 30 }, true);
    sender.claim('dev-a', '', { cols: 100, rows: 30 }, true);

    expect(sent).toHaveLength(0);
  });
});

describe('resolveViewportClaim', () => {
  test('claims the measured geometry while the document is visible', () => {
    expect(
      resolveViewportClaim({
        pageActive: true,
        measured: { cols: 100, rows: 30 },
        lastSize: null,
      })
    ).toEqual({ kind: 'claim', cols: 100, rows: 30, visible: true });
  });

  test('retries while the surface cannot be measured yet', () => {
    expect(resolveViewportClaim({ pageActive: true, measured: null, lastSize: null })).toEqual({
      kind: 'retry',
    });
  });

  test('withdraws with the last known geometry when the document is hidden', () => {
    expect(
      resolveViewportClaim({
        pageActive: false,
        measured: null,
        lastSize: { cols: 100, rows: 30 },
      })
    ).toEqual({ kind: 'claim', cols: 100, rows: 30, visible: false });
  });

  test('a hidden document with nothing measured yet claims nothing', () => {
    expect(resolveViewportClaim({ pageActive: false, measured: null, lastSize: null })).toEqual({
      kind: 'skip',
    });
  });
});

class FakeTarget {
  visibilityState: string | undefined = 'visible';
  private readonly handlers = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(listener);
    this.handlers.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.handlers.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler();
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.handlers.values()) count += set.size;
    return count;
  }
}

function boundHarness() {
  const doc = new FakeTarget();
  const win = new FakeTarget();
  const { sender, sent } = harness();
  const tracker = createPageActivityTracker(doc, win);
  const binding = bindViewportClaims({
    sender,
    tracker,
    deviceId: 'dev-a',
    paneId: '%1',
    measure: () => ({ cols: 100, rows: 30 }),
  });
  return { doc, win, sent, tracker, binding };
}

describe('bindViewportClaims lifecycle', () => {
  test('claims visible on bind', () => {
    const { sent } = boundHarness();

    expect(sent.map((entry) => entry.claim)).toEqual([{ cols: 100, rows: 30, visible: true }]);
  });

  test('pagehide withdraws the claim exactly once', () => {
    const { win, sent } = boundHarness();

    win.emit('pagehide');
    win.emit('pagehide');

    expect(sent.map((entry) => entry.claim.visible)).toEqual([true, false]);
    expect(sent[1]?.claim).toEqual({ cols: 100, rows: 30, visible: false });
  });

  test('pageshow re-sends the visible claim even when nothing changed', () => {
    const { win, sent } = boundHarness();

    win.emit('pageshow');

    expect(sent.map((entry) => entry.claim.visible)).toEqual([true, true]);
  });

  test('pageshow after pagehide restores the claim', () => {
    const { win, sent } = boundHarness();

    win.emit('pagehide');
    win.emit('pageshow');

    expect(sent.map((entry) => entry.claim.visible)).toEqual([true, false, true]);
  });

  test('freeze withdraws, resume re-declares', () => {
    const { doc, sent } = boundHarness();

    doc.emit('freeze');
    doc.emit('resume');

    expect(sent.map((entry) => entry.claim.visible)).toEqual([true, false, true]);
  });

  test('resume while the document is still hidden does not light the claim', () => {
    const { doc, sent } = boundHarness();

    doc.emit('freeze');
    doc.visibilityState = 'hidden';
    doc.emit('resume');

    expect(sent.map((entry) => entry.claim.visible)).toEqual([true, false]);
  });

  test('visibilitychange keeps working', () => {
    const { doc, sent } = boundHarness();

    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');

    expect(sent.map((entry) => entry.claim.visible)).toEqual([true, false, true]);
  });

  test('dispose releases the claim and removes every listener', () => {
    const { doc, win, sent, tracker, binding } = boundHarness();

    binding.dispose();
    tracker.dispose();
    win.emit('pageshow');
    doc.emit('resume');

    expect(sent.map((entry) => entry.claim.visible)).toEqual([true, false]);
    expect(doc.listenerCount()).toBe(0);
    expect(win.listenerCount()).toBe(0);
  });
});
