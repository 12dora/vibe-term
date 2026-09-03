import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_PANE_OUTPUT_FLUSH_MS } from './pane-output-coalescer';
import {
  type PaneSink,
  PaneSinkRegistry,
  cleanupDevicePaneState,
  dispatchPaneTerminalData,
  hasPaneSink,
  registerPaneSink,
  resetPaneSinkRegistryForTest,
} from './pane-sink-registry';
import type { GatewayTerminalData } from './transport';

function createRecordingSink() {
  const events: Array<{ type: string; data?: string }> = [];
  const sink: PaneSink = {
    onOutput: (data) => events.push({ type: 'output', data: new TextDecoder().decode(data) }),
  };
  return { sink, events };
}

function createFrameRecordingSink() {
  const frames: GatewayTerminalData[] = [];
  const sink: PaneSink = {
    onOutput: (_data, frame) => {
      if (frame) frames.push(frame);
    },
  };
  return { sink, frames };
}

const encode = (text: string) => new TextEncoder().encode(text);

function screen(deviceId: string, paneId: string, paneEpoch: Uint8Array, data: string) {
  return {
    deviceId,
    paneId,
    paneEpoch,
    baseSeq: 0n,
    rows: 24,
    cols: 80,
    modes: 0,
    data: encode(data),
    historyCursor: null,
  };
}

// 默认合并窗口是定时器（见 pane-output-coalescer），微任务边界不再触发下发
const flushOutputs = () =>
  new Promise((resolve) => setTimeout(resolve, DEFAULT_PANE_OUTPUT_FLUSH_MS * 4));

afterEach(() => {
  resetPaneSinkRegistryForTest();
});

describe('pane-sink-registry', () => {
  test('replays an atomic screen before sequenced output registered during mount', () => {
    const registry = new PaneSinkRegistry();
    const events: string[] = [];
    const paneEpoch = new Uint8Array(16).fill(3);
    registry.dispatchPaneScreenSnapshot(screen('dev', '%1', paneEpoch, 'screen'));
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%1',
      paneEpoch,
      seqStart: 0n,
      seqEnd: 4n,
      data: encode('live'),
    });

    registry.registerPaneSink('dev', '%1', {
      onScreenSnapshot: () => events.push('screen'),
      onOutput: () => events.push('output'),
    });

    expect(events).toEqual(['screen', 'output']);
  });

  test('turns an unmounted-pane buffer overflow into scoped recovery', () => {
    const registry = new PaneSinkRegistry();
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%1',
      data: new Uint8Array(2 * 1024 * 1024 + 1),
    });
    const reasons: string[] = [];

    registry.registerPaneSink('dev', '%1', {
      onOutput() {},
      onRebase: (reason) => reasons.push(reason),
    });

    expect(reasons).toEqual(['resource_exhausted']);
  });

  test('routes output to the matching pane sink only', async () => {
    const a = createRecordingSink();
    const b = createRecordingSink();
    registerPaneSink('dev', '%1', a.sink);
    registerPaneSink('dev', '%2', b.sink);

    dispatchPaneTerminalData({ deviceId: 'dev', paneId: '%1', data: encode('for-a') });
    dispatchPaneTerminalData({ deviceId: 'dev', paneId: '%2', data: encode('for-b') });
    await flushOutputs();

    expect(a.events).toEqual([{ type: 'output', data: 'for-a' }]);
    expect(b.events).toEqual([{ type: 'output', data: 'for-b' }]);
  });

  test('buffers output written after a screen baseline and replays it on register', () => {
    const registry = new PaneSinkRegistry();
    const paneEpoch = new Uint8Array(16).fill(3);
    registry.dispatchPaneScreenSnapshot(screen('dev', '%1', paneEpoch, 'base'));
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%1',
      paneEpoch,
      seqStart: 0n,
      seqEnd: 5n,
      data: encode('early'),
    });

    const events: string[] = [];
    registry.registerPaneSink('dev', '%1', {
      onScreenSnapshot: (snapshot) => events.push(new TextDecoder().decode(snapshot.data)),
      onOutput: (data) => events.push(new TextDecoder().decode(data)),
    });

    expect(events).toEqual(['base', 'early']);
  });

  test('没有画面基线时挂载前的流中片段被丢弃', () => {
    const registry = new PaneSinkRegistry();
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%1',
      data: encode('orphan'),
    });

    const { sink, events } = createRecordingSink();
    registry.registerPaneSink('dev', '%1', sink);

    expect(events).toEqual([]);
  });

  test('unregister only removes own sink', async () => {
    const a = createRecordingSink();
    const unregister = registerPaneSink('dev', '%1', a.sink);
    const b = createRecordingSink();
    registerPaneSink('dev', '%1', b.sink);

    unregister();
    expect(hasPaneSink('dev', '%1')).toBe(true);

    dispatchPaneTerminalData({ deviceId: 'dev', paneId: '%1', data: encode('x') });
    await flushOutputs();
    expect(b.events).toEqual([{ type: 'output', data: 'x' }]);
    expect(a.events).toEqual([]);
  });

  test('cleanupDevicePaneState drops pending buffers for the device', () => {
    const paneEpoch = new Uint8Array(16).fill(3);
    dispatchPaneTerminalData({ deviceId: 'dev-a', paneId: '%1', data: encode('pending') });
    dispatchPaneTerminalData({ deviceId: 'dev-b', paneId: '%1', data: encode('other-device') });

    cleanupDevicePaneState('dev-a');

    const a = createRecordingSink();
    registerPaneSink('dev-a', '%1', a.sink);
    expect(a.events).toEqual([]);

    const b = createRecordingSink();
    registerPaneSink('dev-b', '%1', b.sink);
    // 无画面基线的流中片段不回放：写进全新空终端只会闪现乱码
    expect(b.events).toEqual([]);
    expect(paneEpoch.byteLength).toBe(16);
  });

  test('replays live bytes written since the screen after canonical history rebuilds it', async () => {
    const registry = new PaneSinkRegistry();
    const paneEpoch = new Uint8Array(16).fill(5);
    const historyEpoch = new Uint8Array(16).fill(6);
    const events: string[] = [];
    let rendered = '';
    registry.registerPaneSink('dev', '%4', {
      onScreenSnapshot: (snapshot) => {
        events.push('screen');
        rendered = new TextDecoder().decode(snapshot.data);
      },
      onHistoryPage: (page) => {
        events.push('history');
        rendered = `${new TextDecoder().decode(page.data)}screen`;
      },
      onOutput: (data) => {
        events.push('live');
        rendered += new TextDecoder().decode(data);
      },
    });
    registry.dispatchPaneScreenSnapshot({
      ...screen('dev', '%4', paneEpoch, 'screen'),
      historyCursor: { paneEpoch, historyEpoch, beforeLine: 10 },
    });
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%4',
      paneEpoch,
      seqStart: 0n,
      seqEnd: 4n,
      data: encode('live'),
    });
    await flushOutputs();
    expect(rendered).toBe('screenlive');

    registry.dispatchPaneHistoryPage({
      requestId: new Uint8Array(16).fill(2),
      deviceId: 'dev',
      paneId: '%4',
      paneEpoch,
      historyEpoch,
      lineStart: 0,
      lineEnd: 10,
      truncated: false,
      data: encode('history'),
      nextCursor: null,
    });

    expect(rendered).toBe('historyscreenlive');
    expect(events).toEqual(['screen', 'live', 'history', 'live']);
  });

  test('does not replay canonical live bytes when the sink rejects a history page', async () => {
    const registry = new PaneSinkRegistry();
    const paneEpoch = new Uint8Array(16).fill(5);
    const historyEpoch = new Uint8Array(16).fill(6);
    let outputs = 0;
    registry.registerPaneSink('dev', '%4', {
      onScreenSnapshot() {},
      onHistoryPage: () => false,
      onOutput: () => {
        outputs += 1;
      },
    });
    registry.dispatchPaneScreenSnapshot({
      ...screen('dev', '%4', paneEpoch, 'screen'),
      historyCursor: { paneEpoch, historyEpoch, beforeLine: 10 },
    });
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%4',
      paneEpoch,
      seqStart: 0n,
      seqEnd: 4n,
      data: encode('live'),
    });
    await flushOutputs();
    expect(outputs).toBe(1);

    registry.dispatchPaneHistoryPage({
      deviceId: 'dev',
      paneId: '%4',
      paneEpoch,
      historyEpoch,
      lineStart: 0,
      lineEnd: 10,
      truncated: false,
      data: encode('history'),
      nextCursor: null,
    });

    expect(outputs).toBe(1);
  });

  test('rejects canonical history after the live replay budget is exhausted', async () => {
    const registry = new PaneSinkRegistry({ canonicalReplayMaxBytes: 3 });
    const paneEpoch = new Uint8Array(16).fill(5);
    const historyEpoch = new Uint8Array(16).fill(6);
    const history: string[] = [];
    const rebases: string[] = [];
    registry.registerPaneSink('dev', '%4', {
      onOutput() {},
      onScreenSnapshot() {},
      onHistoryPage: () => history.push('applied'),
      onRebase: (reason) => rebases.push(reason),
    });
    registry.dispatchPaneScreenSnapshot({
      ...screen('dev', '%4', paneEpoch, 'screen'),
      historyCursor: { paneEpoch, historyEpoch, beforeLine: 10 },
    });
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%4',
      paneEpoch,
      seqStart: 0n,
      seqEnd: 4n,
      data: encode('live'),
    });
    await flushOutputs();
    expect(rebases).toEqual([]);

    registry.dispatchPaneHistoryPage({
      requestId: new Uint8Array(16).fill(2),
      deviceId: 'dev',
      paneId: '%4',
      paneEpoch,
      historyEpoch,
      lineStart: 0,
      lineEnd: 10,
      truncated: false,
      data: encode('history'),
      nextCursor: null,
    });

    expect(history).toEqual([]);
    expect(rebases).toEqual(['resource_exhausted']);
  });

  test('canonical 帧下发时保留 paneEpoch/seq 元数据', async () => {
    const registry = new PaneSinkRegistry();
    const { sink, frames } = createFrameRecordingSink();
    registry.registerPaneSink('dev', '%6', sink);

    const paneEpoch = new Uint8Array(16).fill(8);
    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%6',
      paneEpoch,
      seqStart: 4n,
      seqEnd: 9n,
      data: encode('late'),
    });

    await flushOutputs();

    expect(frames).toEqual([
      {
        deviceId: 'dev',
        paneId: '%6',
        paneEpoch,
        seqStart: 4n,
        seqEnd: 9n,
        data: encode('late'),
      },
    ]);
  });

  test('同一 pane 的连续输出合并成一次 onOutput', async () => {
    const registry = new PaneSinkRegistry();
    const { sink, events } = createRecordingSink();
    registry.registerPaneSink('dev', '%1', sink);

    for (const chunk of ['a', 'b', 'c']) {
      registry.dispatchPaneTerminalData({ deviceId: 'dev', paneId: '%1', data: encode(chunk) });
    }
    expect(events).toEqual([]);

    await flushOutputs();
    expect(events).toEqual([{ type: 'output', data: 'abc' }]);
  });

  test('注销 sink 时把在途输出冲给正在卸载的 sink', () => {
    const registry = new PaneSinkRegistry();
    const { sink, events } = createRecordingSink();
    const unregister = registry.registerPaneSink('dev', '%1', sink);

    registry.dispatchPaneTerminalData({ deviceId: 'dev', paneId: '%1', data: encode('tail') });
    unregister();

    expect(events).toEqual([{ type: 'output', data: 'tail' }]);
  });

  test('换绑 sink 时在途输出归上一任，不写进新终端', () => {
    const registry = new PaneSinkRegistry();
    const first = createRecordingSink();
    const second = createRecordingSink();
    registry.registerPaneSink('dev', '%1', first.sink);

    registry.dispatchPaneTerminalData({ deviceId: 'dev', paneId: '%1', data: encode('for-first') });
    registry.registerPaneSink('dev', '%1', second.sink);

    expect(first.events).toEqual([{ type: 'output', data: 'for-first' }]);
    expect(second.events).toEqual([]);
  });

  test('攒够 32 KiB 立即下发，不等微任务边界', () => {
    const registry = new PaneSinkRegistry();
    const { sink, events } = createRecordingSink();
    registry.registerPaneSink('dev', '%1', sink);

    registry.dispatchPaneTerminalData({
      deviceId: 'dev',
      paneId: '%1',
      data: new Uint8Array(32 * 1024),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.data?.length).toBe(32 * 1024);
  });

  test('device 清理时丢弃在途输出', async () => {
    const registry = new PaneSinkRegistry();
    const { sink, events } = createRecordingSink();
    registry.registerPaneSink('dev', '%1', sink);

    registry.dispatchPaneTerminalData({ deviceId: 'dev', paneId: '%1', data: encode('stale') });
    registry.cleanupDevicePaneState('dev');
    await flushOutputs();

    expect(events).toEqual([]);
  });
});
