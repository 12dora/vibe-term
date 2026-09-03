// per-pane 输出/截屏/历史分发注册表（分屏多 Terminal 实例的路由核心）
//
// 每个 Terminal 实例挂载时以 (deviceId, paneId) 注册一个 sink，卸载时注销。
// canonical feed 的 PaneData / 截屏 / 历史分页统一经本模块路由到对应实例：
// sink 未注册时缓冲有限量输出（Terminal 挂载瞬间的竞态），注册时按「先画面基线后字节」重放。

import { CanonicalLiveReplay } from './canonical-live-replay';
import { PaneOutputCoalescer, type PaneOutputCoalescerOptions } from './pane-output-coalescer';
import type {
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from './transport';

export interface PaneSink {
  onOutput(data: Uint8Array, frame?: GatewayTerminalData): void;
  onScreenSnapshot?(snapshot: GatewayPaneScreenSnapshot): void;
  onHistoryPage?(page: GatewayPaneHistoryPage): unknown;
  onRebase?(reason: GatewayRebaseReason): void;
}

interface PendingPaneState {
  outputs: GatewayTerminalData[];
  outputBytes: number;
  screen: GatewayPaneScreenSnapshot | null;
  historyPages: GatewayPaneHistoryPage[];
  rebase: GatewayRebaseReason | null;
}

export interface PaneSinkRegistryOptions {
  outputCoalescer?: PaneOutputCoalescerOptions;
  canonicalReplayMaxBytes?: number;
}

const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_HISTORY_PAGES = 16;

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}:${paneId}`;
}

// 每个 gateway 连接一份注册表实例；模块级函数代理到默认实例（单连接宿主零改动）
export class PaneSinkRegistry {
  private sinks = new Map<string, PaneSink>();
  private pending = new Map<string, PendingPaneState>();
  private readonly outputs: PaneOutputCoalescer;
  private readonly canonicalReplay: CanonicalLiveReplay;

  constructor(options: PaneSinkRegistryOptions = {}) {
    this.canonicalReplay = new CanonicalLiveReplay(options.canonicalReplayMaxBytes);
    this.outputs = new PaneOutputCoalescer((key, frame) => {
      this.sinks.get(key)?.onOutput(frame.data, frame);
    }, options.outputCoalescer);
  }

  private getPending(key: string): PendingPaneState {
    let state = this.pending.get(key);
    if (!state) {
      state = {
        outputs: [],
        outputBytes: 0,
        screen: null,
        historyPages: [],
        rebase: null,
      };
      this.pending.set(key, state);
    }
    return state;
  }

  registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void {
    const key = paneKey(deviceId, paneId);
    // 换绑前把攒着的字节交回上一任 sink：跨 sink 拼接会把上一任的输出写进新终端
    this.outputs.flush(key);
    this.sinks.set(key, sink);

    const state = this.pending.get(key);
    if (state) {
      this.pending.delete(key);
      if (state.rebase) sink.onRebase?.(state.rebase);
      if (state.screen) sink.onScreenSnapshot?.(state.screen);
      for (const page of state.historyPages) sink.onHistoryPage?.(page);
      // 缓冲的 live 字节只有跟在画面基线（截屏）之后回放才有意义；没有基线时它们是
      // 任意时刻的流中片段，写进全新空终端只会闪现陈旧乱码（挂载后总会重新拉快照，丢弃无损）。
      if (state.screen) {
        for (const frame of state.outputs) {
          this.outputs.push(key, frame);
        }
        this.outputs.flush(key);
      }
    }

    return () => {
      if (this.sinks.get(key) === sink) {
        // 注销时把在途字节冲给正在卸载的 sink（写进已 dispose 的渲染面是安全的空操作），
        // 保持「任何 sink 状态变化都先 flush」这一条规则不出例外
        this.outputs.flush(key);
        this.sinks.delete(key);
      }
    };
  }

  dispatchPaneTerminalData(frame: GatewayTerminalData): void {
    const { deviceId, paneId } = frame;
    const key = paneKey(deviceId, paneId);

    const replayGap = this.canonicalReplay.capture(frame);
    if (replayGap) {
      this.dispatchPaneRebase(deviceId, paneId, replayGap);
      this.canonicalReplay.invalidatePane(deviceId, paneId, replayGap);
      if (replayGap !== 'resource_exhausted') return;
    }

    if (this.sinks.has(key)) {
      this.outputs.push(key, frame);
      return;
    }

    const state = this.getPending(key);
    if (state.outputBytes + frame.data.byteLength > MAX_PENDING_OUTPUT_BYTES) {
      state.outputs = [];
      state.outputBytes = 0;
      state.screen = null;
      state.historyPages = [];
      state.rebase = 'resource_exhausted';
      this.canonicalReplay.invalidatePane(deviceId, paneId, 'resource_exhausted');
      return;
    }
    const pendingFrame = { ...frame, data: new Uint8Array(frame.data) };
    state.outputs.push(pendingFrame);
    state.outputBytes += pendingFrame.data.byteLength;
  }

  dispatchPaneScreenSnapshot(snapshot: GatewayPaneScreenSnapshot): void {
    const key = paneKey(snapshot.deviceId, snapshot.paneId);
    this.canonicalReplay.begin(snapshot);
    this.outputs.flush(key);
    const sink = this.sinks.get(key);
    if (sink?.onScreenSnapshot) {
      sink.onScreenSnapshot(snapshot);
      return;
    }
    const state = this.getPending(key);
    state.screen = snapshot;
    state.historyPages = [];
    state.rebase = null;
  }

  dispatchPaneHistoryPage(page: GatewayPaneHistoryPage): void {
    const key = paneKey(page.deviceId, page.paneId);
    const canonicalReplay = this.canonicalReplay.historyPage(page);
    if (!canonicalReplay.valid) {
      this.dispatchPaneRebase(
        page.deviceId,
        page.paneId,
        canonicalReplay.reason ?? 'cache_evicted'
      );
      return;
    }
    this.outputs.flush(key);
    const sink = this.sinks.get(key);
    let applied = true;
    if (sink?.onHistoryPage) {
      applied = sink.onHistoryPage(page) !== false;
    } else {
      const state = this.getPending(key);
      if (state.historyPages.length >= MAX_PENDING_HISTORY_PAGES) {
        state.historyPages = [];
        state.screen = null;
        state.rebase = 'resource_exhausted';
        this.canonicalReplay.invalidatePane(page.deviceId, page.paneId, 'resource_exhausted');
        applied = false;
      } else {
        state.historyPages.push(page);
      }
    }
    if (applied && sink && canonicalReplay.frames.length > 0) {
      for (const frame of canonicalReplay.frames) this.outputs.push(key, frame);
      this.outputs.flush(key);
    }
  }

  dispatchPaneRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void {
    const key = paneKey(deviceId, paneId);
    this.canonicalReplay.clearPane(deviceId, paneId);
    this.outputs.flush(key);
    const sink = this.sinks.get(key);
    if (sink?.onRebase) {
      sink.onRebase(reason);
      return;
    }
    const state = this.getPending(key);
    state.screen = null;
    state.historyPages = [];
    state.outputs = [];
    state.outputBytes = 0;
    state.rebase = reason;
  }

  hasPaneSink(deviceId: string, paneId: string): boolean {
    return this.sinks.has(paneKey(deviceId, paneId));
  }

  // device 断开/切换时清理该 device 的所有 pending/gate（sink 由组件卸载自行注销）
  cleanupDevicePaneState(deviceId: string): void {
    const prefix = `${deviceId}:`;
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) {
        this.pending.delete(key);
      }
    }
    // 链路已断，在途字节是无主的流中片段：与 pending 缓冲同样直接丢弃，不再下发
    this.outputs.discardMatching((key) => key.startsWith(prefix));
    this.canonicalReplay.clearDevice(deviceId);
  }

  reset(): void {
    this.sinks.clear();
    this.pending.clear();
    this.outputs.discardAll();
    this.canonicalReplay.clear();
  }
}

// 默认实例与模块级代理（保持既有调用面不变）
const defaultRegistry = new PaneSinkRegistry();

export function registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void {
  return defaultRegistry.registerPaneSink(deviceId, paneId, sink);
}

export function dispatchPaneTerminalData(frame: GatewayTerminalData): void {
  defaultRegistry.dispatchPaneTerminalData(frame);
}

export function dispatchPaneScreenSnapshot(snapshot: GatewayPaneScreenSnapshot): void {
  defaultRegistry.dispatchPaneScreenSnapshot(snapshot);
}

export function dispatchPaneHistoryPage(page: GatewayPaneHistoryPage): void {
  defaultRegistry.dispatchPaneHistoryPage(page);
}

export function dispatchPaneRebase(
  deviceId: string,
  paneId: string,
  reason: GatewayRebaseReason
): void {
  defaultRegistry.dispatchPaneRebase(deviceId, paneId, reason);
}

export function hasPaneSink(deviceId: string, paneId: string): boolean {
  return defaultRegistry.hasPaneSink(deviceId, paneId);
}

export function cleanupDevicePaneState(deviceId: string): void {
  defaultRegistry.cleanupDevicePaneState(deviceId);
}

// 仅测试用
export function resetPaneSinkRegistryForTest(): void {
  defaultRegistry.reset();
}
