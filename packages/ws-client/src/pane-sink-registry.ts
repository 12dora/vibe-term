// per-pane 输出/历史分发注册表（分屏多 Terminal 实例的路由核心）
//
// 每个 Terminal 实例挂载时以 (deviceId, paneId) 注册一个 sink，卸载时注销。
// 选择状态机与 store 的消息处理统一通过本模块把字节流路由到对应实例：
// - sink 未注册时缓冲有限量输出（Terminal 挂载瞬间的竞态），注册时重放；
// - fetch-history gate：非焦点 pane 主动拉取首屏时，先缓冲 live 输出，
//   history 应用后再 flush，保证内容顺序（带超时兜底放行）。

// reset 来源：select = 切换/选择流程（随后会有 post-select 尺寸上报）；
// history-refresh = 远端 resize 等触发的内容重建，不得携带本地尺寸上报，
// 否则两个不同视口的客户端会互相抢 window 尺寸形成拉锯
import { type PaneHistoryGateOptions, PaneHistoryGates } from './pane-history-gate';
import { PaneOutputCoalescer, type PaneOutputCoalescerOptions } from './pane-output-coalescer';
import type {
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from './transport';

export type PaneResetOrigin = 'select' | 'history-refresh';

export interface PaneSink {
  onReset(origin: PaneResetOrigin): void;
  onApplyHistory(data: string, alternateScreen: boolean, modes: number): void;
  onOutput(data: Uint8Array, frame?: GatewayTerminalData): void;
  onScreenSnapshot?(snapshot: GatewayPaneScreenSnapshot): void;
  onHistoryPage?(page: GatewayPaneHistoryPage): void;
  onRebase?(reason: GatewayRebaseReason): void;
}

interface PendingPaneState {
  outputs: GatewayTerminalData[];
  outputBytes: number;
  // 缓存的 reset 连同来源一起保留：sink 未挂载时替换为最后一次 reset 的 origin（last-wins），
  // 注册时按原样重放；丢掉 origin 会把 history-refresh 误当作 select 重放并触发本地尺寸上报
  reset: PaneResetOrigin | null;
  history: { data: string; alternateScreen: boolean; modes: number } | null;
  screen: GatewayPaneScreenSnapshot | null;
  historyPages: GatewayPaneHistoryPage[];
  rebase: GatewayRebaseReason | null;
}

export interface PaneSinkRegistryOptions {
  historyGate?: PaneHistoryGateOptions;
  outputCoalescer?: PaneOutputCoalescerOptions;
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
  private readonly historyGates: PaneHistoryGates;
  private readonly outputs: PaneOutputCoalescer;

  constructor(options: PaneSinkRegistryOptions = {}) {
    this.outputs = new PaneOutputCoalescer((key, frame) => {
      this.sinks.get(key)?.onOutput(frame.data, frame);
    }, options.outputCoalescer);
    this.historyGates = new PaneHistoryGates(
      {
        flushFrame: (frame) => {
          this.dispatchPaneTerminalData(frame);
        },
        requestRebase: (deviceId, paneId) => {
          this.dispatchPaneRebase(deviceId, paneId, 'resource_exhausted');
        },
      },
      options.historyGate
    );
  }

  private getPending(key: string): PendingPaneState {
    let state = this.pending.get(key);
    if (!state) {
      state = {
        outputs: [],
        outputBytes: 0,
        reset: null,
        history: null,
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
      if (state.reset) {
        sink.onReset(state.reset);
      }
      if (state.history) {
        sink.onApplyHistory(state.history.data, state.history.alternateScreen, state.history.modes);
      }
      if (state.rebase) sink.onRebase?.(state.rebase);
      if (state.screen) sink.onScreenSnapshot?.(state.screen);
      for (const page of state.historyPages) sink.onHistoryPage?.(page);
      // 缓冲的 live 字节只有跟在画面基线（reset/history/screen）之后回放才有意义；
      // 没有基线时它们是任意时刻的流中片段，写进全新空终端只会闪现陈旧乱码
      //（canonical 路径挂载后总会重新拉快照，丢弃无损）。
      if (state.reset || state.history || state.screen) {
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

  dispatchPaneReset(deviceId: string, paneId: string, origin: PaneResetOrigin = 'select'): void {
    const key = paneKey(deviceId, paneId);
    this.outputs.flush(key);
    const sink = this.sinks.get(key);
    if (sink) {
      sink.onReset(origin);
      return;
    }
    const state = this.getPending(key);
    state.reset = origin;
    state.outputs = [];
    state.outputBytes = 0;
    state.history = null;
    state.screen = null;
    state.historyPages = [];
    state.rebase = null;
  }

  dispatchPaneApplyHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void {
    const key = paneKey(deviceId, paneId);
    this.outputs.flush(key);
    const sink = this.sinks.get(key);
    if (sink) {
      sink.onApplyHistory(data, alternateScreen, modes);
      return;
    }
    this.getPending(key).history = { data, alternateScreen, modes };
  }

  dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    this.dispatchPaneTerminalData({ deviceId, paneId, data });
  }

  dispatchPaneTerminalData(frame: GatewayTerminalData): void {
    const { deviceId, paneId } = frame;
    const key = paneKey(deviceId, paneId);

    if (this.historyGates.capture(frame)) return;

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
      return;
    }
    const pendingFrame = { ...frame, data: new Uint8Array(frame.data) };
    state.outputs.push(pendingFrame);
    state.outputBytes += pendingFrame.data.byteLength;
  }

  dispatchPaneScreenSnapshot(snapshot: GatewayPaneScreenSnapshot): void {
    const key = paneKey(snapshot.deviceId, snapshot.paneId);
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
    this.outputs.flush(key);
    const sink = this.sinks.get(key);
    if (sink?.onHistoryPage) {
      sink.onHistoryPage(page);
      return;
    }
    const state = this.getPending(key);
    if (state.historyPages.length >= MAX_PENDING_HISTORY_PAGES) {
      state.historyPages = [];
      state.screen = null;
      state.rebase = 'resource_exhausted';
      return;
    }
    state.historyPages.push(page);
  }

  dispatchPaneRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void {
    const key = paneKey(deviceId, paneId);
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

  // 开始 fetch-history 门控：此后该 pane 的 live 输出被缓冲，直到
  // dispatchPaneHistory 命中 token 或超时兜底放行
  beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void {
    this.historyGates.begin(deviceId, paneId, token);
  }

  // KIND_TERM_HISTORY 到达时先尝试本函数；token 命中 gate 才消费（返回 true），
  // 否则返回 false 交由选择状态机处理（select 路径）
  dispatchPaneHistory(
    deviceId: string,
    paneId: string,
    token: Uint8Array,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): boolean {
    const buffered = this.historyGates.take(deviceId, paneId, token);
    if (!buffered) return false;

    this.dispatchPaneReset(deviceId, paneId, 'history-refresh');
    this.dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen, modes);
    for (const frame of buffered) {
      this.dispatchPaneTerminalData(frame);
    }
    // 门控放行的是一批已经攒好的字节，没有必要再等微任务边界
    this.outputs.flush(paneKey(deviceId, paneId));
    return true;
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
    this.historyGates.closeDevice(deviceId, { flush: false });
  }

  reset(): void {
    this.sinks.clear();
    this.pending.clear();
    this.outputs.discardAll();
    this.historyGates.closeAll({ flush: false });
  }
}

// 默认实例与模块级代理（保持既有调用面不变）
const defaultRegistry = new PaneSinkRegistry();

export function registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void {
  return defaultRegistry.registerPaneSink(deviceId, paneId, sink);
}

export function dispatchPaneReset(
  deviceId: string,
  paneId: string,
  origin: PaneResetOrigin = 'select'
): void {
  defaultRegistry.dispatchPaneReset(deviceId, paneId, origin);
}

export function dispatchPaneApplyHistory(
  deviceId: string,
  paneId: string,
  data: string,
  alternateScreen: boolean,
  modes: number
): void {
  defaultRegistry.dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen, modes);
}

export function dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void {
  defaultRegistry.dispatchPaneOutput(deviceId, paneId, data);
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

export function beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void {
  defaultRegistry.beginPaneHistoryGate(deviceId, paneId, token);
}

export function dispatchPaneHistory(
  deviceId: string,
  paneId: string,
  token: Uint8Array,
  data: string,
  alternateScreen: boolean,
  modes: number
): boolean {
  return defaultRegistry.dispatchPaneHistory(deviceId, paneId, token, data, alternateScreen, modes);
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
