// `vibeterm term attach` 的交互驱动：本地 TTY ↔ 远端 pane。
//
// 数据面很薄：PaneData 的字节直接写本地 TTY（网关已经把 BEL 与部分 OSC 摘掉），
// 键盘字节按 UTF-8 发成 TerminalInput。画面基线由 RequestScreen 建立，
// pane epoch 变化 / SourceGap 由 canonical 客户端翻成 rebase 事件，收到就重取一次画面。

import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import type { GatewayPaneScreenSnapshot } from '@vibeterm/ws-client';
import { activePane } from '@vibeterm/ws-client/canonical-tree';
import type { CliContext } from './context';
import { EXIT_OK, NetworkError } from './errors';
import type { DeviceSessionEvents } from './pane-session';
import {
  DetachEscapeMatcher,
  type DetachKey,
  type EscapeAction,
  escapeHelpLines,
} from './term-escape';
import { locatePane } from './term-target';
import {
  CLEAR_SCREEN,
  LocalTerminal,
  type LocalTerminalOptions,
  type TtyStreams,
  createStdinDecoder,
  requireTty,
} from './term-tty';
import { type OpenedDeviceSession, openDeviceSession, windowLabel } from './tmux-ops';

export interface AttachOptions {
  detachKey: DetachKey;
  /** 进画面前先补一页滚动历史；0 表示不补。 */
  historyBytes: number;
}

type AttachOutcome = 'detached' | 'closed' | 'failed';

const HISTORY_WAIT_MS = 3_000;
const RECONNECT_DELAY_MS = 500;

function crlf(lines: readonly string[]): string {
  return `${lines.join('\r\n')}\r\n`;
}

export async function runAttach(
  ctx: CliContext,
  targetRaw: string,
  options: AttachOptions,
  streams: TtyStreams = { stdin: process.stdin, stdout: process.stdout },
  terminalOptions: LocalTerminalOptions = {}
): Promise<number> {
  requireTty(streams);
  const runner = new AttachRunner(
    ctx,
    targetRaw,
    options,
    new LocalTerminal(streams, terminalOptions)
  );
  return runner.run();
}

class AttachRunner {
  private readonly matcher: DetachEscapeMatcher;
  private readonly decode = createStdinDecoder();
  private opened: OpenedDeviceSession | null = null;
  private tree: TmuxSession | null = null;
  private window: TmuxWindow | null = null;
  private pane: TmuxPane | null = null;
  private end: ((outcome: AttachOutcome) => void) | null = null;
  private pendingScreen: GatewayPaneScreenSnapshot | null = null;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private historyDone = false;
  /** `finish()` 早于 `attachOnce()` 挂上等待时（连接中就按了 `~.`）先记着。 */
  private pendingOutcome: AttachOutcome | null = null;
  private failure: Error | null = null;
  private sigintHandler: (() => void) | null = null;

  constructor(
    private readonly ctx: CliContext,
    private readonly targetRaw: string,
    private readonly options: AttachOptions,
    private readonly terminal: LocalTerminal
  ) {
    this.matcher = new DetachEscapeMatcher(options.detachKey);
  }

  async run(): Promise<number> {
    try {
      if (this.settled(await this.attachOnce())) return EXIT_OK;
      this.notice('connection lost, reconnecting once…');
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      if (this.pendingOutcome === 'detached') return EXIT_OK;
      if (this.settled(await this.attachOnce())) return EXIT_OK;
      throw new NetworkError('attach: the gateway connection closed');
    } finally {
      this.stopInput();
    }
  }

  /** 'detached' 即正常收尾；'failed' 把回调里的异常原样抛出去。 */
  private settled(outcome: AttachOutcome): boolean {
    if (outcome === 'failed') throw this.failure ?? new Error('attach failed');
    return outcome === 'detached';
  }

  /**
   * raw 模式只在**会话建好之后**才进：连接阶段留在 cooked 模式，Ctrl-C 仍然是真的 SIGINT
   * （连接被中止，终端也没被动过），不会被我们吞掉。重连时终端已经是 raw，不再重复进。
   */
  private startInput(): void {
    if (this.sigintHandler) return;
    this.sigintHandler = () => this.sendKeys('\u0003');
    this.terminal.start(
      this.guard((chunk: Buffer) => this.onInput(chunk)),
      this.guard(() => this.syncSize())
    );
    process.on('SIGINT', this.sigintHandler);
  }

  private stopInput(): void {
    if (this.sigintHandler) process.off('SIGINT', this.sigintHandler);
    this.sigintHandler = null;
    this.clearHistoryTimer();
    this.pendingScreen = null;
    this.terminal.stop();
  }

  /** 回调里抛出的异常不能静悄悄丢掉：会话就此收尾，本地终端才有机会复位。 */
  private guard<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
    return (...args: T) => {
      try {
        fn(...args);
      } catch (error) {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
        this.finish('failed');
      }
    };
  }

  private async attachOnce(): Promise<AttachOutcome> {
    const opened = await openDeviceSession(this.ctx, this.targetRaw, this.sessionEvents());
    this.opened = opened;
    this.tree = opened.tree;
    try {
      const located = locatePane(opened.tree, opened.target);
      this.window = located.window;
      this.pane = located.pane;
      this.historyDone = false;
      this.startInput();
      this.subscribeCurrentPane();
      this.notice(
        `attached to ${opened.nodeName}/${opened.device.name}:${located.window.index}.${located.pane.index} — press ${this.options.detachKey.escapeChar || '(escape disabled)'}${this.options.detachKey.detachChar} to detach`
      );
      return await this.awaitOutcome();
    } finally {
      this.end = null;
      this.clearHistoryTimer();
      this.pendingScreen = null;
      opened.close();
      this.opened = null;
    }
  }

  private sessionEvents(): DeviceSessionEvents {
    return {
      onPaneData: this.guard((frame) => {
        if (frame.paneId === this.pane?.id) this.terminal.write(frame.data);
      }),
      onScreen: this.guard((snapshot) => this.onScreen(snapshot)),
      onHistory: this.guard((page) => this.onHistory(page.data)),
      onRebase: this.guard((_device: string, paneId: string | undefined) => {
        if (!paneId || paneId === this.pane?.id) this.requestScreen();
      }),
      onTree: this.guard((tree) => this.onTree(tree)),
      onDetached: () => this.finish('closed'),
    };
  }

  /** 连接阶段就按过 `~.` 的话这里立刻兑现，不用再等一次事件。 */
  private awaitOutcome(): Promise<AttachOutcome> {
    const pending = this.pendingOutcome;
    if (pending) {
      this.pendingOutcome = null;
      return Promise.resolve(pending);
    }
    return new Promise<AttachOutcome>((resolve) => {
      this.end = resolve;
    });
  }

  private finish(outcome: AttachOutcome): void {
    const end = this.end;
    this.end = null;
    if (end) {
      end(outcome);
      return;
    }
    // 还没挂上等待（连接中 / 重连间隙）：记下来，attachOnce 一挂上就兑现。
    this.pendingOutcome ??= outcome;
  }

  // ------------------------------------------------------------ 画面

  private subscribeCurrentPane(): void {
    const pane = this.pane;
    if (!this.opened || !pane) return;
    this.opened.session.subscribe([pane.id]);
    this.requestScreen();
    this.syncSize();
  }

  private requestScreen(): void {
    if (!this.opened || !this.pane) return;
    this.pendingScreen = null;
    this.clearHistoryTimer();
    this.opened.session.requestScreen(this.pane.id);
  }

  private onScreen(snapshot: GatewayPaneScreenSnapshot): void {
    if (snapshot.paneId !== this.pane?.id) return;
    if (this.options.historyBytes > 0 && !this.historyDone && snapshot.historyCursor) {
      this.historyDone = true;
      this.pendingScreen = snapshot;
      this.historyTimer = setTimeout(() => this.onHistory(null), HISTORY_WAIT_MS);
      this.opened?.session.requestHistory(
        snapshot.paneId,
        snapshot.historyCursor,
        this.options.historyBytes
      );
      return;
    }
    this.paint(null, snapshot);
  }

  private onHistory(data: Uint8Array | null): void {
    const snapshot = this.pendingScreen;
    if (!snapshot) return;
    this.clearHistoryTimer();
    this.pendingScreen = null;
    this.paint(data, snapshot);
  }

  /** 先写历史（它会把本地终端的回滚缓冲喂满），再写截屏（自带一次清屏与光标定位）。 */
  private paint(history: Uint8Array | null, snapshot: GatewayPaneScreenSnapshot): void {
    // 会话已经收尾（detach / 断线 / 重连间隙）时不能再画：那会把陈旧画面泼进复位后的 shell。
    if (!this.opened) return;
    this.terminal.write(CLEAR_SCREEN);
    if (history && history.byteLength > 0) this.terminal.write(history);
    this.terminal.write(snapshot.data);
  }

  private clearHistoryTimer(): void {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
  }

  // ------------------------------------------------------------ 输入

  private onInput(chunk: Buffer): void {
    for (const action of this.matcher.push(this.decode(chunk))) this.dispatch(action);
  }

  private dispatch(action: EscapeAction): void {
    if (action.type === 'send') {
      this.sendKeys(action.data);
      return;
    }
    if (action.type === 'detach') {
      this.notice('detached');
      this.finish('detached');
      return;
    }
    if (action.type === 'help') {
      this.terminal.write(crlf(escapeHelpLines(this.options.detachKey)));
      return;
    }
    if (action.type === 'windows') {
      this.terminal.write(crlf(this.windowLines()));
      return;
    }
    this.switchWindow(action.index);
  }

  private sendKeys(data: string): void {
    if (!this.opened || !this.pane) return;
    this.opened.session.sendInput(this.pane.id, data);
  }

  private windowLines(): string[] {
    const windows = this.tree?.windows ?? [];
    if (windows.length === 0) return ['(no window)'];
    return windows.map(
      (window) =>
        `${window.active ? '*' : ' '} ${window.index}: ${windowLabel(window)} (${window.panes.length} panes)`
    );
  }

  /** `~<n>`：只切换本 CLI 显示的窗口，不动 tmux 自己的活动窗口（那是 `vibeterm tmux select`）。 */
  private switchWindow(index: number): void {
    const window = this.tree?.windows.find((item) => item.index === index);
    const pane = activePane(window ?? null);
    if (!window || !pane) {
      this.terminal.write(crlf([`no window ${index}`]));
      return;
    }
    this.window = window;
    this.pane = pane;
    this.historyDone = true;
    this.subscribeCurrentPane();
  }

  private syncSize(): void {
    if (!this.opened || !this.pane) return;
    const { cols, rows } = this.terminal.size();
    this.opened.session.resize(this.pane.id, cols, rows);
  }

  // ------------------------------------------------------------ 树变化

  private onTree(tree: TmuxSession | null): void {
    this.tree = tree;
    if (!tree) {
      this.notice('the tmux session is gone');
      this.finish('detached');
      return;
    }
    const paneId = this.pane?.id;
    if (!paneId) return;
    for (const window of tree.windows) {
      const pane = window.panes.find((item) => item.id === paneId);
      if (!pane) continue;
      this.window = window;
      this.pane = pane;
      return;
    }
    this.notice(`pane ${paneId} closed`);
    this.finish('detached');
  }

  private notice(text: string): void {
    if (this.ctx.globals.quiet) return;
    this.terminal.write(crlf([`[vibeterm] ${text}`]));
  }
}
