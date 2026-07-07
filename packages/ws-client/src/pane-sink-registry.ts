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
export type PaneResetOrigin = 'select' | 'history-refresh';

export interface PaneSink {
  onReset(origin: PaneResetOrigin): void;
  onApplyHistory(data: string, alternateScreen: boolean, modes: number): void;
  onOutput(data: Uint8Array): void;
}

interface PendingPaneState {
  outputs: Uint8Array[];
  reset: boolean;
  history: { data: string; alternateScreen: boolean; modes: number } | null;
}

interface HistoryGate {
  token: Uint8Array;
  buffer: Uint8Array[];
  timer: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_OUTPUTS = 1000;
const HISTORY_GATE_TIMEOUT_MS = 3000;

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}:${paneId}`;
}

function tokensEqual(expected: Uint8Array, received: Uint8Array): boolean {
  if (expected.length !== received.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== received[i]) return false;
  }
  return true;
}

function splitPaneKey(key: string): [string, string] {
  const idx = key.lastIndexOf(':');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// 每个 gateway 连接一份注册表实例；模块级函数代理到默认实例（单连接宿主零改动）
export class PaneSinkRegistry {
  private sinks = new Map<string, PaneSink>();
  private pending = new Map<string, PendingPaneState>();
  private historyGates = new Map<string, HistoryGate>();

  private getPending(key: string): PendingPaneState {
    let state = this.pending.get(key);
    if (!state) {
      state = { outputs: [], reset: false, history: null };
      this.pending.set(key, state);
    }
    return state;
  }

  registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void {
    const key = paneKey(deviceId, paneId);
    this.sinks.set(key, sink);

    const state = this.pending.get(key);
    if (state) {
      this.pending.delete(key);
      if (state.reset) {
        sink.onReset('select');
      }
      if (state.history) {
        sink.onApplyHistory(state.history.data, state.history.alternateScreen, state.history.modes);
      }
      for (const data of state.outputs) {
        sink.onOutput(data);
      }
    }

    return () => {
      if (this.sinks.get(key) === sink) {
        this.sinks.delete(key);
      }
    };
  }

  dispatchPaneReset(deviceId: string, paneId: string, origin: PaneResetOrigin = 'select'): void {
    const key = paneKey(deviceId, paneId);
    const sink = this.sinks.get(key);
    if (sink) {
      sink.onReset(origin);
      return;
    }
    const state = this.getPending(key);
    state.reset = true;
    state.outputs = [];
    state.history = null;
  }

  dispatchPaneApplyHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void {
    const key = paneKey(deviceId, paneId);
    const sink = this.sinks.get(key);
    if (sink) {
      sink.onApplyHistory(data, alternateScreen, modes);
      return;
    }
    this.getPending(key).history = { data, alternateScreen, modes };
  }

  dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const key = paneKey(deviceId, paneId);

    const gate = this.historyGates.get(key);
    if (gate) {
      if (gate.buffer.length >= MAX_PENDING_OUTPUTS) {
        gate.buffer.shift();
      }
      gate.buffer.push(new Uint8Array(data));
      return;
    }

    const sink = this.sinks.get(key);
    if (sink) {
      sink.onOutput(data);
      return;
    }

    const state = this.getPending(key);
    if (state.outputs.length >= MAX_PENDING_OUTPUTS) {
      state.outputs.shift();
    }
    state.outputs.push(new Uint8Array(data));
  }

  // 开始 fetch-history 门控：此后该 pane 的 live 输出被缓冲，直到
  // dispatchPaneHistory 命中 token 或超时兜底放行
  beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void {
    const key = paneKey(deviceId, paneId);
    this.closePaneHistoryGate(key, { flush: true });

    const timer = setTimeout(() => {
      console.warn(`[pane-sink] history gate timeout on ${key}, releasing buffered output`);
      this.closePaneHistoryGate(key, { flush: true });
    }, HISTORY_GATE_TIMEOUT_MS);

    this.historyGates.set(key, { token: new Uint8Array(token), buffer: [], timer });
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
    const key = paneKey(deviceId, paneId);
    const gate = this.historyGates.get(key);
    if (!gate || !tokensEqual(gate.token, token)) {
      return false;
    }

    clearTimeout(gate.timer);
    this.historyGates.delete(key);

    this.dispatchPaneReset(deviceId, paneId, 'history-refresh');
    this.dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen, modes);
    for (const buffered of gate.buffer) {
      this.dispatchPaneOutput(deviceId, paneId, buffered);
    }
    return true;
  }

  private closePaneHistoryGate(key: string, opts: { flush: boolean }): void {
    const gate = this.historyGates.get(key);
    if (!gate) return;
    clearTimeout(gate.timer);
    this.historyGates.delete(key);
    if (opts.flush) {
      const [deviceId, paneId] = splitPaneKey(key);
      for (const buffered of gate.buffer) {
        this.dispatchPaneOutput(deviceId, paneId, buffered);
      }
    }
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
    for (const key of this.historyGates.keys()) {
      if (key.startsWith(prefix)) {
        this.closePaneHistoryGate(key, { flush: false });
      }
    }
  }

  reset(): void {
    this.sinks.clear();
    this.pending.clear();
    for (const key of this.historyGates.keys()) {
      this.closePaneHistoryGate(key, { flush: false });
    }
  }
}

// 默认实例与模块级代理（保持既有调用面不变）
const defaultRegistry = new PaneSinkRegistry();

export function getDefaultPaneSinkRegistry(): PaneSinkRegistry {
  return defaultRegistry;
}

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
