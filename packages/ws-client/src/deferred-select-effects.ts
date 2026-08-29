export interface DeferredHistory {
  paneId: string;
  data: string;
  alternateScreen: boolean;
  modes: number;
}

export interface DeferredSelectCallbacks {
  onResetTerminal?: (deviceId: string, paneId: string) => void;
  onApplyHistory?: (
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ) => void;
  onFlushBuffer?: (deviceId: string, paneId: string, buffer: Uint8Array[]) => void;
  onOutput?: (deviceId: string, paneId: string, data: Uint8Array) => void;
}

interface DeferredFlush {
  paneId: string;
  buffer: Uint8Array[];
}

interface DeferredOutput {
  paneId: string;
  data: Uint8Array;
}

export class DeferredSelectEffects {
  private readonly resets = new Map<string, string>();
  private readonly histories = new Map<string, DeferredHistory>();
  private readonly flushes = new Map<string, DeferredFlush>();
  private readonly outputs = new Map<string, DeferredOutput[]>();

  deferReset(deviceId: string, paneId: string): void {
    this.resets.set(deviceId, paneId);
  }

  deferHistory(deviceId: string, history: DeferredHistory): void {
    this.histories.set(deviceId, history);
  }

  deferFlush(deviceId: string, paneId: string, buffer: Uint8Array[]): void {
    this.flushes.set(deviceId, { paneId, buffer });
  }

  deferOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const pending = this.outputs.get(deviceId) ?? [];
    pending.push({ paneId, data: new Uint8Array(data) });
    this.outputs.set(deviceId, pending);
  }

  historyOrDefer(
    deviceId: string,
    history: DeferredHistory,
    callbacks: DeferredSelectCallbacks
  ): void {
    if (callbacks.onResetTerminal && callbacks.onApplyHistory) {
      callbacks.onResetTerminal(deviceId, history.paneId);
      callbacks.onApplyHistory(
        deviceId,
        history.paneId,
        history.data,
        history.alternateScreen,
        history.modes
      );
      return;
    }
    this.deferHistory(deviceId, history);
  }

  resetOrDefer(
    deviceId: string,
    paneId: string,
    onResetTerminal: DeferredSelectCallbacks['onResetTerminal']
  ): void {
    if (onResetTerminal) {
      onResetTerminal(deviceId, paneId);
      return;
    }
    this.deferReset(deviceId, paneId);
  }

  flushOrDefer(
    deviceId: string,
    paneId: string,
    buffered: Uint8Array[],
    onFlushBuffer: DeferredSelectCallbacks['onFlushBuffer']
  ): void {
    if (onFlushBuffer && !this.hasReplacement(deviceId)) {
      onFlushBuffer(deviceId, paneId, buffered);
    } else if (buffered.length > 0) {
      this.deferFlush(deviceId, paneId, buffered);
    }
  }

  outputOrDefer(
    deviceId: string,
    paneId: string,
    data: Uint8Array,
    onOutput: DeferredSelectCallbacks['onOutput']
  ): void {
    if (onOutput) {
      onOutput(deviceId, paneId, data);
      return;
    }
    this.deferOutput(deviceId, paneId, data);
  }

  hasReplacement(deviceId: string): boolean {
    return this.resets.has(deviceId) || this.histories.has(deviceId);
  }

  deviceIds(): string[] {
    return [
      ...new Set([
        ...this.resets.keys(),
        ...this.histories.keys(),
        ...this.flushes.keys(),
        ...this.outputs.keys(),
      ]),
    ];
  }

  clear(deviceId?: string): void {
    if (deviceId === undefined) {
      this.resets.clear();
      this.histories.clear();
      this.flushes.clear();
      this.outputs.clear();
      return;
    }
    this.resets.delete(deviceId);
    this.histories.delete(deviceId);
    this.flushes.delete(deviceId);
    this.outputs.delete(deviceId);
  }

  replay(deviceId: string, callbacks: DeferredSelectCallbacks): void {
    this.replayReset(deviceId, callbacks);
    this.replayHistory(deviceId, callbacks);
    if (this.hasReplacement(deviceId)) {
      return;
    }
    this.replayFlush(deviceId, callbacks);
    this.replayOutputs(deviceId, callbacks);
  }

  private replayReset(deviceId: string, callbacks: DeferredSelectCallbacks): void {
    const paneId = this.resets.get(deviceId);
    if (paneId === undefined || !callbacks.onResetTerminal) {
      return;
    }
    this.resets.delete(deviceId);
    callbacks.onResetTerminal(deviceId, paneId);
  }

  private replayHistory(deviceId: string, callbacks: DeferredSelectCallbacks): void {
    const history = this.histories.get(deviceId);
    if (history === undefined || !callbacks.onResetTerminal || !callbacks.onApplyHistory) {
      return;
    }
    callbacks.onResetTerminal(deviceId, history.paneId);
    callbacks.onApplyHistory(
      deviceId,
      history.paneId,
      history.data,
      history.alternateScreen,
      history.modes
    );
    this.histories.delete(deviceId);
  }

  private replayFlush(deviceId: string, callbacks: DeferredSelectCallbacks): void {
    const flush = this.flushes.get(deviceId);
    if (!flush || !callbacks.onFlushBuffer) {
      return;
    }
    callbacks.onFlushBuffer(deviceId, flush.paneId, flush.buffer);
    this.flushes.delete(deviceId);
  }

  private replayOutputs(deviceId: string, callbacks: DeferredSelectCallbacks): void {
    const outputs = this.outputs.get(deviceId);
    if (!outputs || !callbacks.onOutput) {
      return;
    }
    for (const output of outputs) {
      callbacks.onOutput(deviceId, output.paneId, output.data);
    }
    this.outputs.delete(deviceId);
  }
}
