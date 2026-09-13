// `vibeterm term`：像 ssh 一样接进任意 node 上某个 pane，或者以非交互方式发按键 / 取画面 / 跑命令。
//
// 四条子命令共用同一条数据面：订阅 pane → RequestScreen 建基线 → PaneData 流。
// attach 的交互部分在 core/term-attach.ts，采集与洗白在 core/term-collect.ts、core/vt-text.ts。

import type { TmuxPane, TmuxWindow } from '@vibeterm/shared';
import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
} from '@vibeterm/ws-client';
import { type FlagValues, flagBool, flagNumber, flagString, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { InterruptError, NetworkError, NotFoundError, UsageError } from '../core/errors';
import type { DeviceSessionEvents } from '../core/pane-session';
import { readAllStdin } from '../core/prompt';
import { runAttach } from '../core/term-attach';
import { ByteCollector, IdleWatcher } from '../core/term-collect';
import { parseDetachKey } from '../core/term-escape';
import { hexToSequence, keysToSequence } from '../core/term-keys';
import { runTermCommand } from '../core/term-run';
import { locatePane } from '../core/term-target';
import { type OpenedDeviceSession, openDeviceSession } from '../core/tmux-ops';
import { stripAnsi } from '../core/vt-text';
import type { Command } from './types';

const FLAGS = {
  'detach-key': 'string',
  history: 'number',
  hex: 'boolean',
  stdin: 'boolean',
  literal: 'boolean',
  'wait-idle': 'number',
  'strip-ansi': 'boolean',
  raw: 'boolean',
  idle: 'number',
  marker: 'boolean',
  'allow-timeout': 'boolean',
  ephemeral: 'boolean',
  force: 'boolean',
  'no-json': 'boolean',
} as const;

const TARGET_HINT = 'target syntax: [<node>/]<device>[:<window>[.<pane>]]';
const ACK_WAIT_MS = 1_500;

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

function nextValue<T>(waiters: Array<Waiter<T>>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const drop = (): void => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      clearTimeout(timer);
    };
    const waiter: Waiter<T> = {
      resolve: (value) => {
        drop();
        resolve(value);
      },
      reject: (error) => {
        drop();
        reject(error);
      },
    };
    const timer = setTimeout(() => {
      drop();
      reject(new NetworkError(message));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

/** 每条非交互子命令共用的会话面：连设备、定位 pane、订阅、取画面、发按键。 */
class PaneStream {
  readonly output = new ByteCollector();
  private readonly screenWaiters: Array<Waiter<GatewayPaneScreenSnapshot>> = [];
  private readonly historyWaiters: Array<Waiter<GatewayPaneHistoryPage>> = [];
  private readonly dataHooks = new Set<() => void>();
  private watcher: IdleWatcher | null = null;
  private opened: OpenedDeviceSession | null = null;
  private paneId = '';
  private failure: Error | null = null;

  constructor(private readonly ctx: CliContext) {}

  async open(target: string): Promise<{
    opened: OpenedDeviceSession;
    window: TmuxWindow;
    pane: TmuxPane;
  }> {
    const opened = await openDeviceSession(this.ctx, target, this.events());
    try {
      const located = locatePane(opened.tree, opened.target);
      this.opened = opened;
      this.paneId = located.pane.id;
      opened.session.subscribe([located.pane.id]);
      return { opened, ...located };
    } catch (error) {
      opened.close();
      throw error;
    }
  }

  private events(): DeviceSessionEvents {
    return {
      onPaneData: (frame) => {
        if (frame.paneId !== this.paneId) return;
        // 收满上限就别再等静默了：`yes` 这类命令永远不会安静下来。
        if (!this.output.append(frame.data)) this.watcher?.done();
        this.watcher?.note();
        for (const hook of this.dataHooks) hook();
      },
      onScreen: (snapshot) => {
        if (snapshot.paneId !== this.paneId) return;
        for (const waiter of this.screenWaiters.splice(0)) waiter.resolve(snapshot);
      },
      onHistory: (page) => {
        if (page.paneId !== this.paneId) return;
        for (const waiter of this.historyWaiters.splice(0)) waiter.resolve(page);
      },
      // SubscriptionApplied / SourceGap / pane epoch 变化都会让网关重新拦住这个 pane 的字节，
      // 不重取一次画面就再也收不到 PaneData。
      onRebase: (_deviceId, paneId) => {
        if (!paneId || paneId === this.paneId) this.opened?.session.requestScreen(this.paneId);
      },
      onTree: (tree) => {
        if (!tree) this.fail(new NotFoundError('the tmux session on this device is gone'));
      },
      onDetached: (reason) => this.fail(new NetworkError(`pane stream stopped: ${reason}`)),
    };
  }

  /** 断流不是「安静」：所有在等的东西立刻失败，采集中的命令也马上收尾。 */
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.screenWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this.historyWaiters.splice(0)) waiter.reject(error);
    this.watcher?.done();
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  abort(): void {
    const error = new InterruptError();
    this.fail(error);
    this.opened?.session.rejectWaiters(error);
  }

  /** 取一次画面。订阅之后必须至少取一次：网关在建立游标前不会放行 PaneData。 */
  screen(): Promise<GatewayPaneScreenSnapshot> {
    this.throwIfFailed();
    const waited = nextValue(
      this.screenWaiters,
      timeoutOf(this.ctx),
      `pane ${this.paneId} did not return a screen in time`
    );
    this.opened?.session.requestScreen(this.paneId);
    return waited;
  }

  history(cursor: GatewayHistoryCursor, byteLimit: number): Promise<GatewayPaneHistoryPage> {
    this.throwIfFailed();
    const waited = nextValue(
      this.historyWaiters,
      timeoutOf(this.ctx),
      `pane ${this.paneId} did not return a history page in time`
    );
    this.opened?.session.requestHistory(this.paneId, cursor, byteLimit);
    return waited;
  }

  sendInput(data: string): void {
    this.opened?.session.sendInput(this.paneId, data);
  }

  retarget(_window: TmuxWindow, pane: TmuxPane): void {
    this.paneId = pane.id;
    this.opened?.session.subscribe([pane.id]);
  }

  attachWatcher(watcher: IdleWatcher | null): void {
    this.watcher = watcher;
  }

  onData(hook: () => void): () => void {
    this.dataHooks.add(hook);
    return () => this.dataHooks.delete(hook);
  }
}

function timeoutOf(ctx: CliContext): number {
  return ctx.globals.timeoutMs;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function requireTarget(target: string | undefined, sub: string): string {
  if (!target) throw new UsageError(`vibeterm term ${sub} needs a target`, TARGET_HINT);
  return target;
}

// ------------------------------------------------------------------ attach

async function attachCommand(ctx: CliContext, flags: FlagValues, rest: string[]): Promise<number> {
  const target = requireTarget(rest[0], 'attach');
  return runAttach(ctx, target, {
    detachKey: parseDetachKey(flagString(flags, 'detach-key')),
    historyBytes: Math.max(0, flagNumber(flags, 'history') ?? 0),
  });
}

// -------------------------------------------------------------------- send

async function sendKeysSequence(flags: FlagValues, keys: string[]): Promise<string> {
  if (flagBool(flags, 'stdin')) return readAllStdin();
  if (keys.length === 0) throw new UsageError('vibeterm term send needs keys (or --stdin)');
  if (flagBool(flags, 'hex')) return hexToSequence(keys.join(''));
  return keysToSequence(keys, { literal: flagBool(flags, 'literal') });
}

async function sendCommand(ctx: CliContext, flags: FlagValues, rest: string[]): Promise<number> {
  const target = requireTarget(rest[0], 'send');
  const data = await sendKeysSequence(flags, rest.slice(1));
  const stream = new PaneStream(ctx);
  const { opened, pane } = await stream.open(target);
  try {
    await stream.screen();
    const before = stream.output.byteLength;
    stream.sendInput(data);
    const echoed = await waitForEcho(stream, before);
    const bytes = Buffer.byteLength(data, 'utf8');
    if (ctx.out.json) ctx.out.data({ ok: true, pane: pane.id, bytes, echoed });
    else ctx.out.info(`sent ${bytes} byte(s) to ${pane.id}${echoed ? '' : ' (no echo seen)'}`);
    return 0;
  } finally {
    opened.close();
  }
}

/** 回显是「服务端确实把按键送进了 pane」的唯一可观测信号；不回显的程序不算失败。 */
async function waitForEcho(stream: PaneStream, before: number): Promise<boolean> {
  const deadline = Date.now() + ACK_WAIT_MS;
  while (Date.now() < deadline && stream.output.byteLength <= before) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return stream.output.byteLength > before;
}

// ----------------------------------------------------------------- capture

async function captureCommand(ctx: CliContext, flags: FlagValues, rest: string[]): Promise<number> {
  const target = requireTarget(rest[0], 'capture');
  const stream = new PaneStream(ctx);
  const { opened, pane } = await stream.open(target);
  try {
    let snapshot = await stream.screen();
    const waitIdle = flagNumber(flags, 'wait-idle') ?? 0;
    if (waitIdle > 0) {
      const watcher = new IdleWatcher({ idleMs: waitIdle, timeoutMs: timeoutOf(ctx) });
      stream.attachWatcher(watcher);
      await watcher.wait();
      stream.attachWatcher(null);
      snapshot = await stream.screen();
    }
    const historyBytes = flagNumber(flags, 'history') ?? 0;
    const history =
      historyBytes > 0 && snapshot.historyCursor
        ? await stream.history(snapshot.historyCursor, historyBytes)
        : null;
    printCapture(ctx, flags, pane.id, snapshot, history);
    return 0;
  } finally {
    opened.close();
  }
}

function printCapture(
  ctx: CliContext,
  flags: FlagValues,
  paneId: string,
  snapshot: GatewayPaneScreenSnapshot,
  history: GatewayPaneHistoryPage | null
): void {
  const screenBytes = snapshot.data;
  const historyBytes = history?.data ?? new Uint8Array();
  if (ctx.out.json) {
    ctx.out.data({
      pane: paneId,
      paneEpoch: base64(snapshot.paneEpoch),
      seq: String(snapshot.baseSeq),
      screen: base64(screenBytes),
      text: stripAnsi(screenBytes),
      ...(history
        ? { history: { screen: base64(historyBytes), text: stripAnsi(historyBytes) } }
        : {}),
    });
    return;
  }
  if (flagBool(flags, 'strip-ansi')) {
    if (history) ctx.out.line(stripAnsi(historyBytes));
    ctx.out.line(stripAnsi(screenBytes));
    return;
  }
  if (history) ctx.out.raw(historyBytes);
  ctx.out.raw(screenBytes);
  if (!flagBool(flags, 'raw')) ctx.out.line();
}

// --------------------------------------------------------------------- run

async function runCommand(ctx: CliContext, flags: FlagValues, rest: string[]): Promise<number> {
  requireTarget(rest[0], 'run');
  return runTermCommand(ctx, flags, rest, new PaneStream(ctx));
}

// ------------------------------------------------------------------ 分发

type TermHandler = (ctx: CliContext, flags: FlagValues, rest: string[]) => Promise<number>;

const HANDLERS: Readonly<Record<string, TermHandler>> = {
  attach: attachCommand,
  send: sendCommand,
  capture: captureCommand,
  run: runCommand,
};

async function run(ctx: CliContext, argv: string[]): Promise<number> {
  const { flags, positionals } = parseArgv(argv, FLAGS);
  const [sub, ...rest] = positionals;
  const handler = sub ? HANDLERS[sub] : undefined;
  if (!handler) {
    throw new UsageError(
      sub ? `unknown term subcommand: ${sub}` : 'missing subcommand',
      `known subcommands: ${Object.keys(HANDLERS).join(', ')}`
    );
  }
  return handler(ctx, flags, rest);
}

export const command: Command = {
  name: 'term',
  summary: 'attach to a pane, send keys, capture the screen or run a command',
  usage: [
    'Usage: vibeterm term <attach|send|capture|run> <target> [args] [options]',
    '',
    `Target: ${TARGET_HINT}`,
    '  omit the window/pane part to use the active pane of the active window',
    '',
    'attach <target>                 interactive, ssh-like; needs a TTY',
    '  --detach-key <2 chars>        escape sequence (default "~.", "none" disables it)',
    '  --history <bytes>             preload this much scrollback before the first screen',
    '  escape keys (type at the start of a line):',
    '    ~.  detach      ~w  list windows      ~<n>~  show window n      ~?  help      ~~  literal ~',
    '    (a bare ~<n> lands on the next key; ~<n>~ or ~<n><Enter> switches right away)',
    '',
    'send <target> <keys…>           send keys and exit',
    '  keys use tmux send-keys names: Enter, Escape, Tab, C-c, M-x, S-Up, F5, Up, PageDown…',
    '  unknown words are sent literally; --literal sends every word literally',
    '  --hex <bytes>                 send raw hex ("1b5b41"); must decode to valid UTF-8',
    '  --stdin                       send everything on stdin instead of the key words',
    '',
    'capture <target>                print the current screen',
    '  --strip-ansi                  plain text instead of the raw VT bytes',
    '  --raw                         raw bytes with no trailing newline',
    '  --history <bytes>             also fetch one page of scrollback',
    '  --wait-idle <ms>              wait until the pane has been silent this long first',
    '',
    'run <target> "<command>"        type a command, wait for the output to go idle, print it',
    '  argv form must be a single line; --stdin / @file send a bracketed-paste block then CR',
    '  a bare `exit N` terminates the pane shell so the marker cannot run — use `(exit N)` or `sh -c`',
    '  --idle <ms>                   silence that counts as "done" (default 800)',
    '  --timeout <ms>                hard cap on the whole wait (default 30000)',
    '  --marker                      type "(echo __VT_DONE_<nonce>_$?)" on its own line afterwards',
    '  --stdin / @file               multi-line body as one bracketed-paste block + CR',
    '  --ephemeral                   new-window -d, wait until the new pane emits output and goes',
    '                                idle (--idle, capped by --timeout), run there, then close-window',
    '                                (always attempted; old nodes fail with exit 5:',
    '                                该节点版本过旧，不支持 --ephemeral)',
    '  --force                       type even if the pane is not a shell',
    '  --no-json                     keep human output when stdout is not a TTY',
    '  --allow-timeout               exit 0 even when the output was cut short',
    '  --raw                         raw bytes instead of the scrubbed text',
    "  a lone node name (no /device) falls back to that node's first local device",
    '',
    'JSON (--json):',
    '  send     {"ok":true,"pane":"%3","bytes":5,"echoed":true}',
    '  capture  {"pane":"%3","paneEpoch":"<b64>","seq":"1234","screen":"<b64>","text":"…"}',
    '           plus "history":{"screen":"<b64>","text":"…"} when --history is given',
    '  run      {"pane":"%3","command":"…","reason":"idle|timeout|done|truncated","exitCode":0|null,',
    '            "output":"…","raw":"<b64>"}',
    '  non-TTY stdout without --json behaves as --json (agent default); --no-json opts out',
    '  [borsh-client] State lines are omitted in --json / non-TTY; human TTY still prints them',
    '',
    'run/capture are best-effort for agents: the pane is a shared terminal. Prefer',
    '`vibeterm exec` for a real non-interactive process. Busy panes (currentCommand not a',
    'shell) refuse unless --force or --ephemeral. --marker is a visible sentinel; a command',
    'that reads stdin will eat it.',
    '',
    'Exit codes: 0 ok — including a non-zero exit code inside the pane (see "exitCode");',
    '1 when run could not collect the whole output (reason timeout|truncated) unless',
    '--allow-timeout; 2 when attach has no TTY or the target pane is busy; 3 when the node',
    'needs a login; 4 for an unknown target; 5 when the gateway connection fails.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
