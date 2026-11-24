import type { TerminalPredictionHost } from 'ghostty-terminal';
import { type PredictionEngine, createPredictionEngine } from './engine';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PredictiveEchoControllerOptions {
  host: TerminalPredictionHost;
  /** 输入法 textarea：组字期间不显示预测 */
  textarea?: HTMLElement | null;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** 预测引擎与终端宿主之间的胶水：帧订阅、输入法、过期定时与 overlay 下发。关闭时零开销。 */
export class PredictiveEchoController {
  private readonly host: TerminalPredictionHost;
  private readonly textarea: HTMLElement | null;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly engine: PredictionEngine;
  private active = false;
  private composing = false;
  private pasting = false;
  private shownVersion: number;
  private overlayShown = false;
  private timer: TimerHandle | null = null;
  private detach: (() => void) | null = null;

  constructor(options: PredictiveEchoControllerOptions) {
    this.host = options.host;
    this.textarea = options.textarea ?? null;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.engine = createPredictionEngine({
      textWidth: (text) => this.host.textWidth(text),
      now: this.now,
    });
    this.shownVersion = this.engine.version;
  }

  get isActive(): boolean {
    return this.active;
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.attach();
    } else {
      this.detach?.();
      this.detach = null;
      this.composing = false;
      this.clear();
    }
  }

  setRttMs(rttMs: number | null): void {
    this.engine.setRttMs(rttMs);
  }

  /** paste = 这段字节来自粘贴：不预测，只结束当前 epoch */
  noteInput(data: string, paste = false): void {
    if (!this.active) return;
    if (paste || this.pasting) this.engine.breakRun();
    else this.engine.onInput(data, this.host.frame());
    this.flush();
  }

  reset(): void {
    if (!this.active) return;
    this.clear();
  }

  dispose(): void {
    this.setActive(false);
  }

  private attach(): void {
    const offFrame = this.host.onFrame((frame) => {
      if (this.composing) return;
      this.engine.onFrame(frame);
      this.flush();
    });
    const textarea = this.textarea;
    if (!textarea) {
      this.detach = offFrame;
      return;
    }
    const onCompositionStart = (): void => {
      this.composing = true;
      this.clear();
    };
    const onCompositionEnd = (): void => {
      this.composing = false;
    };
    // 捕获阶段先于终端自己的 paste 监听：其同步 emit 的字节在本 task 内都按粘贴处理
    const onPaste = (): void => {
      this.pasting = true;
      queueMicrotask(() => {
        this.pasting = false;
      });
    };
    textarea.addEventListener('compositionstart', onCompositionStart);
    textarea.addEventListener('compositionend', onCompositionEnd);
    textarea.addEventListener('paste', onPaste, true);
    this.detach = () => {
      offFrame();
      textarea.removeEventListener('compositionstart', onCompositionStart);
      textarea.removeEventListener('compositionend', onCompositionEnd);
      textarea.removeEventListener('paste', onPaste, true);
    };
  }

  private clear(): void {
    this.engine.reset();
    this.cancelTimer();
    if (this.overlayShown) this.host.setOverlay(null);
    this.overlayShown = false;
    this.shownVersion = this.engine.version;
  }

  private flush(): void {
    if (this.engine.version !== this.shownVersion) {
      this.shownVersion = this.engine.version;
      const overlay = this.engine.overlay();
      if (overlay || this.overlayShown) this.host.setOverlay(overlay);
      this.overlayShown = overlay !== null;
    }
    this.schedule();
  }

  private schedule(): void {
    this.cancelTimer();
    const deadline = this.engine.nextDeadline();
    if (deadline === null) return;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        this.engine.tick();
        this.flush();
      },
      Math.max(0, deadline - this.now()) + 1
    );
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
