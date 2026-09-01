import { describe, expect, test } from 'bun:test';
import {
  type ViewportClaim,
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
        documentVisible: true,
        measured: { cols: 100, rows: 30 },
        lastSize: null,
      })
    ).toEqual({ kind: 'claim', cols: 100, rows: 30, visible: true });
  });

  test('retries while the surface cannot be measured yet', () => {
    expect(resolveViewportClaim({ documentVisible: true, measured: null, lastSize: null })).toEqual(
      { kind: 'retry' }
    );
  });

  test('withdraws with the last known geometry when the document is hidden', () => {
    expect(
      resolveViewportClaim({
        documentVisible: false,
        measured: null,
        lastSize: { cols: 100, rows: 30 },
      })
    ).toEqual({ kind: 'claim', cols: 100, rows: 30, visible: false });
  });

  test('a hidden document with nothing measured yet claims nothing', () => {
    expect(
      resolveViewportClaim({ documentVisible: false, measured: null, lastSize: null })
    ).toEqual({ kind: 'skip' });
  });
});
