import { describe, expect, test } from 'bun:test';
import type { TmuxSourceMetadataEvent } from './events';
import type { PaneStreamNotification } from './pane-stream-parser';

import { createControlModeSubscription } from './control-mode-subscription';
import type { ControlStreamMetricsSnapshot } from './control-stream-metrics';

const encoder = new TextEncoder();

function lines(...items: string[]): Uint8Array {
  return encoder.encode(`${items.join('\n')}\n`);
}

interface Collected {
  outputs: Array<{ paneId: string; text: string }>;
  titles: Array<{ paneId: string; title: string }>;
  bells: string[];
  notifications: Array<{ paneId: string; notification: PaneStreamNotification }>;
  pauses: string[];
  continues: string[];
  metadata: TmuxSourceMetadataEvent[];
  structureChanges: number;
  exits: Array<string | null>;
}

function createCollector() {
  const collected: Collected = {
    outputs: [],
    titles: [],
    bells: [],
    notifications: [],
    pauses: [],
    continues: [],
    metadata: [],
    structureChanges: 0,
    exits: [],
  };
  const subscription = createControlModeSubscription({
    onTerminalOutput: (paneId, data) => {
      collected.outputs.push({ paneId, text: new TextDecoder().decode(data) });
    },
    onTitle: (paneId, title) => {
      collected.titles.push({ paneId, title });
    },
    onBell: (paneId) => {
      collected.bells.push(paneId);
    },
    onNotification: (paneId, notification) => {
      collected.notifications.push({ paneId, notification });
    },
    onPause: (paneId) => {
      collected.pauses.push(paneId);
    },
    onContinue: (paneId) => {
      collected.continues.push(paneId);
    },
    onSourceMetadata: (event) => {
      collected.metadata.push(event);
    },
    onStructureChanged: () => {
      collected.structureChanges += 1;
    },
    onExit: (reason) => {
      collected.exits.push(reason);
    },
  });
  return { subscription, collected };
}

describe('control mode subscription', () => {
  test('routes %output through per-pane stream parsers', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 hello', '%output %2 world'));
    expect(collected.outputs).toEqual([
      { paneId: '%1', text: 'hello' },
      { paneId: '%2', text: 'world' },
    ]);
    subscription.dispose();
  });

  test('extracts bell and strips it from terminal output', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 A\\007B'));
    expect(collected.outputs).toEqual([{ paneId: '%1', text: 'AB' }]);
    expect(collected.bells).toEqual(['%1']);
    subscription.dispose();
  });

  test('parses OSC 9 notification escaped in control stream', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %4 \\033]9;hi from claude\\007'));
    expect(collected.notifications).toEqual([
      { paneId: '%4', notification: { source: 'osc9', body: 'hi from claude' } },
    ]);
    expect(collected.outputs).toEqual([]);
    subscription.dispose();
  });

  test('parses tmux-passthrough-wrapped OSC 777 split across %output lines', () => {
    const { subscription, collected } = createCollector();
    // DCS tmux; 包装：ESC P tmux; ... ESC ESC ] ... ESC \
    subscription.push(lines('%output %7 \\033Ptmux;\\033\\033]777;notify;Title;Bo'));
    subscription.push(lines('%output %7 dy\\007\\033\\134'));
    expect(collected.notifications).toEqual([
      {
        paneId: '%7',
        notification: { source: 'osc777', title: 'Title', body: 'Body' },
      },
    ]);
    subscription.dispose();
  });

  test('emits pane title updates', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 \\033]2;my-title\\007'));
    expect(collected.titles).toEqual([{ paneId: '%1', title: 'my-title' }]);
    subscription.dispose();
  });

  test('keeps per-pane parser state independent across interleaved output', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 \\033]9;part'));
    subscription.push(lines('%output %2 plain'));
    subscription.push(lines('%output %1 ial\\007'));
    expect(collected.outputs).toEqual([{ paneId: '%2', text: 'plain' }]);
    expect(collected.notifications).toEqual([
      { paneId: '%1', notification: { source: 'osc9', body: 'partial' } },
    ]);
    subscription.dispose();
  });

  test('maps known structural notifications directly and coalesces only missing-field reconcile', async () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%window-add @1', '%layout-change @1 x y !', '%window-renamed @1 zsh'));
    expect(collected.structureChanges).toBe(0);
    expect(collected.metadata).toEqual([
      { type: 'layout-change', windowId: '@1', layout: 'x' },
      { type: 'window-renamed', windowId: '@1', name: 'zsh' },
    ]);
    await Bun.sleep(80);
    expect(collected.structureChanges).toBe(1);
    subscription.dispose();
  });

  test('parses shared format subscription values without losing spaces', () => {
    const { subscription, collected } = createCollector();
    subscription.push(
      lines(
        '%subscription-changed tmex-cwd \u00241 @1 0 %7 : /work/tree with spaces',
        '%subscription-changed tmex-command \u00241 @1 0 %7 : cargo test'
      )
    );
    expect(collected.metadata).toEqual([
      { type: 'pane-current-path', paneId: '%7', currentPath: '/work/tree with spaces' },
      { type: 'pane-current-command', paneId: '%7', currentCommand: 'cargo test' },
    ]);
    expect(collected.structureChanges).toBe(0);
    subscription.dispose();
  });

  test('non-structural notifications do not trigger snapshot refresh', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%client-session-changed client-1 $0 t1', '%pause %1', '%continue %1'));
    expect(collected.structureChanges).toBe(0);
    subscription.dispose();
  });

  test('%pause notification invokes onPause callback with pane id', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%pause %1'));
    expect(collected.pauses).toEqual(['%1']);
    subscription.dispose();
  });

  test('%continue notification invokes onContinue callback with pane id', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%continue %1'));
    expect(collected.continues).toEqual(['%1']);
    subscription.dispose();
  });

  test('forwards %exit reason', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%exit detached'));
    expect(collected.exits).toEqual(['detached']);
    subscription.dispose();
  });

  test('prunePanes drops parsers for closed panes', () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%output %1 a', '%output %2 b'));
    subscription.prunePanes(new Set(['%1']));
    subscription.push(lines('%output %1 c', '%output %2 d'));
    // %2 的 parser 被清掉后会重新懒建，输出仍然可达（pane id 复用场景）
    expect(collected.outputs.map((item) => item.text)).toEqual(['a', 'b', 'c', 'd']);
    subscription.dispose();
  });

  test('dispose cancels pending trailing structure callback', async () => {
    const { subscription, collected } = createCollector();
    subscription.push(lines('%window-add @1', '%window-add @2'));
    expect(collected.structureChanges).toBe(0);
    subscription.dispose();
    await Bun.sleep(80);
    expect(collected.structureChanges).toBe(0);
  });

  test('reports raw, parsed, and swallowed control traffic in one bounded window', () => {
    const collected: ControlStreamMetricsSnapshot[] = [];
    let nowMs = 0;
    const collector = createCollector();
    collector.subscription.dispose();
    const first = lines('%output %1 hello');
    const second = lines('%output %1 \\033]2;title\\007');
    const subscription = createControlModeSubscription(
      {
        onTerminalOutput: () => {},
        onTitle: () => {},
        onBell: () => {},
        onNotification: () => {},
        onStructureChanged: () => {},
        onExit: () => {},
      },
      {
        metricsIntervalMs: 10,
        nowMs: () => nowMs,
        onMetrics: (snapshot) => collected.push(snapshot),
      }
    );

    subscription.push(first);
    nowMs = 10;
    subscription.push(second);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      rawChunks: 2,
      rawBytes: first.length + second.length,
      controlOutputs: 2,
      terminalOutputs: 1,
      terminalOutputBytes: 5,
      titles: 1,
    });
    subscription.dispose();
  });
});
