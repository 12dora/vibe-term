import { describe, expect, test } from 'bun:test';

import type { PaneInfo } from './capture-history';
import type { EmulatorStreamListener, EmulatorStreamSource } from './pane-emulator';
import {
  DEFAULT_SCROLLBACK,
  hasRetentionSource,
  resolveEmulatorOptions,
  seedFromPaneText,
  seedFromRetention,
  subscribePaneStream,
} from './pane-emulator-create';
import { PaneRetention } from './pane-retention';
import type { PromptMarker } from './pane-stream-parser';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function paneInfo(cols: number, rows: number): PaneInfo {
  return {
    cols,
    rows,
    cursorX: 0,
    cursorY: 0,
    alternateScreen: false,
    currentCommand: 'bash',
  };
}

function baseSource(overrides: Partial<EmulatorStreamSource> = {}): EmulatorStreamSource {
  return {
    subscribe() {
      return () => {};
    },
    async capturePaneText() {
      return '';
    },
    async getPaneInfo() {
      return paneInfo(80, 24);
    },
    ...overrides,
  };
}

function fakeTerminal() {
  const writes: Array<string | Uint8Array> = [];
  let freed = false;
  return {
    writes,
    get freed() {
      return freed;
    },
    write(data: string | Uint8Array) {
      writes.push(data);
    },
    free() {
      freed = true;
    },
  };
}

describe('resolveEmulatorOptions', () => {
  test.each([
    {
      name: 'null info uses 80x24 and default scrollback',
      info: null,
      opts: undefined,
      expected: { cols: 80, rows: 24, scrollback: DEFAULT_SCROLLBACK },
    },
    {
      name: 'zero cols and rows fall back to defaults',
      info: { cols: 0, rows: 0 },
      opts: undefined,
      expected: { cols: 80, rows: 24, scrollback: DEFAULT_SCROLLBACK },
    },
    {
      name: 'negative cols and rows fall back to defaults',
      info: { cols: -4, rows: -1 },
      opts: { scrollback: 120 },
      expected: { cols: 80, rows: 24, scrollback: 120 },
    },
    {
      name: 'positive size and explicit scrollback are kept',
      info: { cols: 120, rows: 40 },
      opts: { scrollback: 200 },
      expected: { cols: 120, rows: 40, scrollback: 200 },
    },
  ])('$name', ({ info, opts, expected }) => {
    expect(resolveEmulatorOptions(info, opts)).toEqual(expected);
  });
});

describe('hasRetentionSource', () => {
  test('requires identity, consumer, screen, and replay APIs', () => {
    expect(hasRetentionSource(baseSource())).toBe(false);
    expect(
      hasRetentionSource(
        baseSource({
          getPaneIdentity: () => ({ paneId: '%1', paneEpoch: new Uint8Array(16) }),
          attachPaneConsumer: () => {
            throw new Error('unused');
          },
          captureCanonicalScreen: async () => null,
          readPaneReplay: () => null,
        })
      )
    ).toBe(true);
    expect(
      hasRetentionSource(
        baseSource({
          getPaneIdentity: () => null,
          attachPaneConsumer: () => {
            throw new Error('unused');
          },
          captureCanonicalScreen: async () => null,
        })
      )
    ).toBe(false);
  });
});

describe('subscribePaneStream', () => {
  test('forwards only matching pane output and markers, and omits unused handlers', () => {
    const listeners: EmulatorStreamListener[] = [];
    const source = baseSource({
      subscribe(listener) {
        listeners.push(listener);
        return () => {};
      },
    });
    const outputs: string[] = [];
    const markers: PromptMarker[] = [];
    subscribePaneStream(source, '%1', {
      onOutput: (data) => outputs.push(decoder.decode(data)),
      onMarker: (marker) => markers.push(marker),
    });
    const both = listeners[0];
    both?.onTerminalOutput?.('%1', encoder.encode('a'));
    both?.onTerminalOutput?.('%2', encoder.encode('b'));
    both?.onPromptMarker?.('%1', { kind: 'A', exitCode: null, params: [] });
    both?.onPromptMarker?.('%2', { kind: 'B', exitCode: null, params: [] });
    expect(outputs).toEqual(['a']);
    expect(markers).toEqual([{ kind: 'A', exitCode: null, params: [] }]);

    subscribePaneStream(source, '%1', {
      onMarker: () => {},
    });
    expect(listeners[1]?.onTerminalOutput).toBeUndefined();
    expect(listeners[1]?.onPromptMarker).toBeDefined();
  });
});

describe('seedFromPaneText', () => {
  test('normalizes captured text, skips empty seed, and swallows capture errors', async () => {
    const written: string[] = [];
    await seedFromPaneText(
      baseSource({
        async capturePaneText() {
          return 'hello\nworld';
        },
      }),
      '%1',
      { write: (data) => written.push(data) }
    );
    expect(written).toEqual(['hello\r\nworld\r\n']);

    written.length = 0;
    await seedFromPaneText(baseSource(), '%1', { write: (data) => written.push(data) });
    expect(written).toEqual([]);

    await seedFromPaneText(
      baseSource({
        async capturePaneText() {
          throw new Error('offline');
        },
      }),
      '%1',
      { write: (data) => written.push(data) }
    );
    expect(written).toEqual([]);
  });
});

describe('seedFromRetention', () => {
  test('writes checkpoint then replay and returns an open lease', async () => {
    const retention = new PaneRetention({ scheduleTimers: false });
    const paneEpoch = new Uint8Array(16).fill(7);
    retention.reconcilePanes([{ paneId: '%1', paneEpoch }]);
    const terminal = fakeTerminal();
    const fed: string[] = [];
    const source = baseSource({
      getPaneIdentity() {
        return { paneId: '%1', paneEpoch };
      },
      attachPaneConsumer(callbacks) {
        return retention.attachConsumer(callbacks);
      },
      async captureCanonicalScreen() {
        retention.ingest('%1', paneEpoch, encoder.encode('before\r\n'));
        const cursor = retention.getLatestCursor('%1');
        if (!cursor) return null;
        const checkpoint = {
          paneId: '%1',
          paneEpoch,
          baseSeq: cursor.terminalSeq,
          rows: 24,
          cols: 80,
          modes: 0,
          data: encoder.encode('seed\r\n'),
          historyCursor: null,
          capturedAt: 1,
        };
        retention.storeScreenCheckpoint(checkpoint);
        retention.ingest('%1', paneEpoch, encoder.encode('after\r\n'));
        return checkpoint;
      },
      readPaneReplay(paneId, cursor) {
        return retention.readReplay(paneId, cursor);
      },
    });

    const lease = await seedFromRetention(source, '%1', terminal, (data) => {
      fed.push(decoder.decode(data));
    });
    expect(terminal.writes.map((part) => decoder.decode(part as Uint8Array))).toEqual([
      'seed\r\n',
      'after\r\n',
    ]);
    expect(terminal.freed).toBe(false);
    expect(retention.snapshotStats().activePanes).toBe(1);
    lease.close();
    expect(retention.snapshotStats().activePanes).toBe(0);
    retention.dispose();
    expect(fed).toEqual(['before\r\n', 'after\r\n']);
  });

  test('frees the terminal when the pane identity is missing', async () => {
    const terminal = fakeTerminal();
    await expect(
      seedFromRetention(
        baseSource({
          getPaneIdentity: () => null,
          attachPaneConsumer: () => {
            throw new Error('should not attach');
          },
          captureCanonicalScreen: async () => null,
          readPaneReplay: () => null,
        }),
        '%1',
        terminal,
        () => {}
      )
    ).rejects.toThrow('pane not found: %1');
    expect(terminal.freed).toBe(true);
    expect(terminal.writes).toEqual([]);
  });

  test('closes the lease and frees the terminal when screen capture is missing or throws', async () => {
    const retention = new PaneRetention({ scheduleTimers: false });
    const paneEpoch = new Uint8Array(16).fill(3);
    retention.reconcilePanes([{ paneId: '%1', paneEpoch }]);
    const missing = fakeTerminal();
    const source = baseSource({
      getPaneIdentity() {
        return { paneId: '%1', paneEpoch };
      },
      attachPaneConsumer(callbacks) {
        return retention.attachConsumer(callbacks);
      },
      captureCanonicalScreen: async () => null,
      readPaneReplay: () => null,
    });
    await expect(seedFromRetention(source, '%1', missing, () => {})).rejects.toThrow(
      'pane screen unavailable: %1'
    );
    expect(missing.freed).toBe(true);
    expect(retention.snapshotStats().activePanes).toBe(0);

    const throwing = fakeTerminal();
    await expect(
      seedFromRetention(
        {
          ...source,
          captureCanonicalScreen: async () => {
            throw new Error('capture failed');
          },
        },
        '%1',
        throwing,
        () => {}
      )
    ).rejects.toThrow('capture failed');
    expect(throwing.freed).toBe(true);
    expect(retention.snapshotStats().activePanes).toBe(0);
    retention.dispose();
  });

  test('closes the lease when replay is missing after the checkpoint', async () => {
    const retention = new PaneRetention({ scheduleTimers: false });
    const paneEpoch = new Uint8Array(16).fill(9);
    retention.reconcilePanes([{ paneId: '%1', paneEpoch }]);
    const terminal = fakeTerminal();
    await expect(
      seedFromRetention(
        baseSource({
          getPaneIdentity() {
            return { paneId: '%1', paneEpoch };
          },
          attachPaneConsumer(callbacks) {
            return retention.attachConsumer(callbacks);
          },
          async captureCanonicalScreen() {
            return {
              paneId: '%1',
              paneEpoch,
              baseSeq: 0n,
              rows: 24,
              cols: 80,
              modes: 0,
              data: encoder.encode('seed'),
              historyCursor: null,
              capturedAt: 1,
            };
          },
          readPaneReplay: () => ({
            paneId: '%1',
            paneEpoch,
            segments: [],
            gap: {
              paneId: '%1',
              paneEpoch,
              reason: 'pane_gap',
              expectedPaneEpoch: paneEpoch,
              expectedSeq: 0n,
              availableSeq: 0n,
            },
            needsScreen: true,
          }),
        }),
        '%1',
        terminal,
        () => {}
      )
    ).rejects.toThrow('pane replay unavailable after screen capture: %1');
    expect(terminal.freed).toBe(true);
    expect(retention.snapshotStats().activePanes).toBe(0);
    retention.dispose();
  });
});
