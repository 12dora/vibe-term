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

type AttachOutcome = 'detached' | 'closed';

const HISTORY_WAIT_MS = 3_000;
const RECONNECT_DELAY_MS = 500;

function crlf(lines: readonly string[]): string {
  return `${lines.join('\r\n')}\r\n`;
}

export async function runAttach(
  ctx: CliContext,
  targetRaw: string,
  options: AttachOptions,
  streams: TtyStreams = { stdin: process.stdin, stdout: process.stdout }
): Promise<number> {
  requireTty(streams);
  const runner = new AttachRunner(ctx, targetRaw, options, new LocalTerminal(streams));
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

  constructor(
    private readonly ctx: CliContext,
    private readonly targetRaw: string,
    private readonly options: AttachOptions,
    private readonly terminal: LocalTerminal
  ) {
    this.matcher = new DetachEscapeMatcher(options.detachKey);
  }

  async run(): Promise<number> {
    const onSigint = (): void => this.sendKeys('\u0003');
    this.terminal.start(
      (chunk) => this.onInput(chunk),
      () => this.syncSize()
    );
    process.on('SIGINT', onSigint);
    try {
      if ((await this.attachOnce()) === 'detached') return EXIT_OK;
      this.notice('connection lost, reconnecting once…');
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
      if ((await this.attachOnce()) === 'detached') return EXIT_OK;
      throw new NetworkError('attach: the gateway connection closed');
    } finally {
      process.off('SIGINT', onSigint);
      this.clearHistoryTimer();
      this.terminal.stop();
    }
  }

  private async attachOnce(): Promise<AttachOutcome> {
    const opened = await openDeviceSession(this.ctx, this.targetRaw, {
      onPaneData: (frame) => {
        if (frame.paneId === this.pane?.id) this.terminal.write(frame.data);
      },
      onScreen: (snapshot) => this.onScreen(snapshot),
      onHistory: (page) => this.onHistory(page.data),
      onRebase: (_device, paneId, _reason) => {
        if (!paneId || paneId === this.pane?.id) this.requestScreen();
      },
      onTree: (tree) => this.onTree(tree),
      onDetached: () => this.finish('closed'),
    });
    this.opened = opened;
    this.tree = opened.tree;
    try {
      const located = locatePane(opened.tree, opened.target);
      this.window = located.window;
      this.pane = located.pane;
      this.historyDone = false;
      this.subscribeCurrentPane();
      this.notice(
        `attached to ${opened.nodeName}/${opened.device.name}:${located.window.index}.${located.pane.index} — press ${this.options.detachKey.escapeChar || '(escape disabled)'}${this.options.detachKey.detachChar} to detach`
      );
      return await new Promise<AttachOutcome>((resolve) => {
        this.end = resolve;
      });
    } finally {
      this.end = null;
      opened.close();
      this.opened = null;
    }
  }

  private finish(outcome: AttachOutcome): void {
    const end = this.end;
    this.end = null;
    end?.(outcome);
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
    const paneId = this.pane?.id;
    if (!tree || !paneId) return;
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
