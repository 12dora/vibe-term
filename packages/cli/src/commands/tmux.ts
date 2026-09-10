// `vibeterm tmux`：查看并驱动一台设备上的 tmux 窗口 / pane。
//
// 每条子命令都是「建 WS → 连设备 → 等会话树 → 发控制命令 → 等元数据补丁落地 → 打印 → 关」。
// 定位窗口 / pane 的规则见 core/term-target.ts，控制命令的 wire 形态见 @vibeterm/ws-client。

import type { TmuxPane, TmuxSession, TmuxWindow } from '@vibeterm/shared';
import { type FlagValues, flagBool, flagString, parseArgv } from '../core/args';
import type { CliContext } from '../core/context';
import { NotFoundError, UsageError } from '../core/errors';
import { locatePane, locateWindow } from '../core/term-target';
import {
  type OpenedDeviceSession,
  applyTmuxChange,
  firstNew,
  openDeviceSession,
  paneById,
  paneIds,
  paneRow,
  printSessionTree,
  windowById,
  windowIds,
  windowLabel,
} from '../core/tmux-ops';
import type { Command } from './types';

const FLAGS = {
  name: 'string',
  cwd: 'string',
  horizontal: 'boolean',
  vertical: 'boolean',
  all: 'boolean',
} as const;

interface TmuxInput {
  ctx: CliContext;
  opened: OpenedDeviceSession;
  rest: string[];
  flags: FlagValues;
}

type TmuxHandler = (input: TmuxInput) => Promise<void>;

const TARGET_HINT = 'target syntax: [<node>/]<device>[:<window>[.<pane>]]';

function timeoutOf(ctx: CliContext): number {
  return ctx.globals.timeoutMs;
}

function header(opened: OpenedDeviceSession): string {
  return `${opened.nodeName}/${opened.device.name}`;
}

function windowJson(window: TmuxWindow): Record<string, unknown> {
  return {
    id: window.id,
    index: window.index,
    name: windowLabel(window),
    active: window.active,
    panes: window.panes.length,
  };
}

function requireArg(rest: readonly string[], what: string): string {
  const value = rest[0];
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

async function lsCommand({ ctx, opened }: TmuxInput): Promise<void> {
  if (ctx.out.json) {
    ctx.out.data([opened.tree]);
    return;
  }
  printSessionTree(ctx.out, opened.tree, header(opened));
}

async function windowsCommand({ ctx, opened }: TmuxInput): Promise<void> {
  const windows = opened.tree.windows;
  if (ctx.out.json) {
    ctx.out.data(windows);
    return;
  }
  ctx.out.table(windows, [
    { header: 'INDEX', value: (window) => String(window.index) },
    { header: 'ID', value: (window) => window.id },
    { header: 'NAME', value: (window) => windowLabel(window) },
    { header: 'ACTIVE', value: (window) => (window.active ? '*' : '') },
    { header: 'PANES', value: (window) => String(window.panes.length) },
  ]);
}

function panesOf(opened: OpenedDeviceSession, all: boolean): TmuxPane[] {
  if (all) return opened.tree.windows.flatMap((window) => window.panes);
  return locateWindow(opened.tree, opened.target).panes;
}

async function panesCommand({ ctx, opened, flags }: TmuxInput): Promise<void> {
  const panes = panesOf(opened, flagBool(flags, 'all'));
  if (ctx.out.json) {
    ctx.out.data(panes);
    return;
  }
  ctx.out.table(panes.map(paneRow), [
    { header: 'ID', value: (row) => String(row.id) },
    { header: 'INDEX', value: (row) => String(row.index) },
    { header: 'ACTIVE', value: (row) => (row.active ? '*' : '') },
    { header: 'SIZE', value: (row) => String(row.size) },
    { header: 'COMMAND', value: (row) => String(row.command) },
    { header: 'PATH', value: (row) => String(row.path) },
  ]);
}

function reportWindow(ctx: CliContext, action: string, window: TmuxWindow): void {
  if (ctx.out.json) {
    ctx.out.data({ ok: true, action, window: windowJson(window) });
    return;
  }
  ctx.out.line(`${action}: ${window.id} (${window.index}: ${windowLabel(window)})`);
}

function reportPane(ctx: CliContext, action: string, pane: TmuxPane): void {
  if (ctx.out.json) {
    ctx.out.data({ ok: true, action, pane: paneRow(pane) });
    return;
  }
  ctx.out.line(`${action}: ${pane.id} (${pane.width}x${pane.height})`);
}

function reportGone(ctx: CliContext, action: string, id: string): void {
  if (ctx.out.json) {
    ctx.out.data({ ok: true, action, id });
    return;
  }
  ctx.out.line(`${action}: ${id}`);
}

async function newWindowCommand({ ctx, opened, flags, rest }: TmuxInput): Promise<void> {
  const before = windowIds(opened.tree);
  const name = flagString(flags, 'name') ?? rest[0];
  const cwd = flagString(flags, 'cwd');
  const tree = await applyTmuxChange(
    opened,
    {
      type: 'create-window',
      deviceId: opened.device.id,
      ...(name ? { name } : {}),
      ...(cwd ? { cwd } : {}),
    },
    (next) => firstNew(before, windowIds(next)) !== null,
    'the new window to appear',
    timeoutOf(ctx)
  );
  const created = firstNew(before, windowIds(tree));
  const window = created ? windowById(tree, created) : null;
  if (!window) throw new NotFoundError('the new window vanished before it could be reported');
  reportWindow(ctx, 'created', window);
}

async function killWindowCommand({ ctx, opened }: TmuxInput): Promise<void> {
  const window = locateWindow(opened.tree, opened.target);
  await applyTmuxChange(
    opened,
    { type: 'close-window', deviceId: opened.device.id, windowId: window.id },
    (next) => !windowIds(next).has(window.id),
    `window ${window.id} to close`,
    timeoutOf(ctx)
  );
  reportGone(ctx, 'closed window', window.id);
}

async function renameWindowCommand({ ctx, opened, flags, rest }: TmuxInput): Promise<void> {
  const window = locateWindow(opened.tree, opened.target);
  const name = flagString(flags, 'name') ?? requireArg(rest, 'new window name');
  const tree = await applyTmuxChange(
    opened,
    { type: 'rename-window', deviceId: opened.device.id, windowId: window.id, name },
    (next) => {
      const updated = windowById(next, window.id);
      return updated !== null && windowLabel(updated) === name;
    },
    `window ${window.id} to be renamed`,
    timeoutOf(ctx)
  );
  const updated = windowById(tree, window.id);
  if (!updated) throw new NotFoundError(`window ${window.id} disappeared while renaming`);
  reportWindow(ctx, 'renamed', updated);
}

function splitDirection(flags: FlagValues): 'right' | 'down' {
  const horizontal = flagBool(flags, 'horizontal');
  const vertical = flagBool(flags, 'vertical');
  if (horizontal && vertical) throw new UsageError('--horizontal and --vertical are exclusive');
  return horizontal ? 'right' : 'down';
}

async function splitCommand({ ctx, opened, flags }: TmuxInput): Promise<void> {
  const { window, pane } = locatePane(opened.tree, opened.target);
  const before = paneIds(opened.tree, window.id);
  const cwd = flagString(flags, 'cwd');
  const tree = await applyTmuxChange(
    opened,
    {
      type: 'split-pane',
      deviceId: opened.device.id,
      paneId: pane.id,
      direction: splitDirection(flags),
      ...(cwd ? { cwd } : {}),
    },
    (next) => firstNew(before, paneIds(next, window.id)) !== null,
    'the new pane to appear',
    timeoutOf(ctx)
  );
  const created = firstNew(before, paneIds(tree, window.id));
  const newPane = created ? paneById(tree, created) : null;
  if (!newPane) throw new NotFoundError('the new pane vanished before it could be reported');
  reportPane(ctx, 'split', newPane);
}

async function killPaneCommand({ ctx, opened }: TmuxInput): Promise<void> {
  const { pane } = locatePane(opened.tree, opened.target);
  await applyTmuxChange(
    opened,
    { type: 'close-pane', deviceId: opened.device.id, paneId: pane.id },
    (next) => paneById(next, pane.id) === null,
    `pane ${pane.id} to close`,
    timeoutOf(ctx)
  );
  reportGone(ctx, 'closed pane', pane.id);
}

async function selectCommand({ ctx, opened }: TmuxInput): Promise<void> {
  const window = locateWindow(opened.tree, opened.target);
  const tree = await applyTmuxChange(
    opened,
    { type: 'select-window', deviceId: opened.device.id, windowId: window.id },
    (next) => windowById(next, window.id)?.active === true,
    `window ${window.id} to become active`,
    timeoutOf(ctx)
  );
  reportWindow(ctx, 'selected', windowById(tree, window.id) ?? window);
}

async function focusCommand({ ctx, opened }: TmuxInput): Promise<void> {
  const { window, pane } = locatePane(opened.tree, opened.target);
  const tree = await applyTmuxChange(
    opened,
    {
      type: 'focus-pane',
      deviceId: opened.device.id,
      windowId: window.id,
      paneId: pane.id,
    },
    (next) => paneById(next, pane.id)?.active === true,
    `pane ${pane.id} to become active`,
    timeoutOf(ctx)
  );
  reportPane(ctx, 'focused', paneById(tree, pane.id) ?? pane);
}

/** `80x24`。tmux 会按窗口约束夹取，所以这里只请求，不保证拿到原值。 */
export function parseGeometry(raw: string | undefined): { cols: number; rows: number } {
  const match = /^(\d{1,4})[xX](\d{1,4})$/.exec(raw ?? '');
  if (!match) throw new UsageError(`expected a <cols>x<rows> size, got "${raw ?? '(missing)'}"`);
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols < 1 || rows < 1) throw new UsageError('cols and rows must both be at least 1');
  return { cols, rows };
}

async function resizeCommand({ ctx, opened, rest }: TmuxInput): Promise<void> {
  const { pane } = locatePane(opened.tree, opened.target);
  const size = parseGeometry(rest[0]);
  const changed = (next: TmuxSession): boolean => {
    const updated = paneById(next, pane.id);
    return updated !== null && (updated.width !== pane.width || updated.height !== pane.height);
  };
  opened.session.send({
    type: 'resize-pane-in-window',
    deviceId: opened.device.id,
    paneId: pane.id,
    cols: size.cols,
    rows: size.rows,
  });
  const tree = await opened.session
    .awaitTreeChange(changed, timeoutOf(ctx), `pane ${pane.id} to be resized`)
    .catch(() => null);
  if (!tree) ctx.out.warn(`tmux kept ${pane.id} at ${pane.width}x${pane.height} (layout clamped)`);
  reportPane(ctx, 'resized', (tree && paneById(tree, pane.id)) ?? pane);
}

async function renamePaneCommand({ ctx, opened, flags, rest }: TmuxInput): Promise<void> {
  const { pane } = locatePane(opened.tree, opened.target);
  const name = flagString(flags, 'name') ?? requireArg(rest, 'new pane name');
  const tree = await applyTmuxChange(
    opened,
    { type: 'rename-pane', deviceId: opened.device.id, paneId: pane.id, name },
    (next) => paneById(next, pane.id)?.customName === name,
    `pane ${pane.id} to be renamed`,
    timeoutOf(ctx)
  );
  reportPane(ctx, 'renamed', paneById(tree, pane.id) ?? pane);
}

const HANDLERS: Readonly<Record<string, TmuxHandler>> = {
  ls: lsCommand,
  windows: windowsCommand,
  panes: panesCommand,
  'new-window': newWindowCommand,
  'kill-window': killWindowCommand,
  'rename-window': renameWindowCommand,
  split: splitCommand,
  'kill-pane': killPaneCommand,
  select: selectCommand,
  focus: focusCommand,
  resize: resizeCommand,
  'rename-pane': renamePaneCommand,
};

async function run(ctx: CliContext, argv: string[]): Promise<undefined> {
  const { flags, positionals } = parseArgv(argv, FLAGS);
  const [sub, target, ...rest] = positionals;
  const handler = sub ? HANDLERS[sub] : undefined;
  if (!handler) {
    throw new UsageError(
      sub ? `unknown tmux subcommand: ${sub}` : 'missing subcommand',
      `known subcommands: ${Object.keys(HANDLERS).join(', ')}`
    );
  }
  if (!target) throw new UsageError(`vibeterm tmux ${sub} needs a target`, TARGET_HINT);
  const opened = await openDeviceSession(ctx, target);
  try {
    await handler({ ctx, opened, rest, flags });
  } finally {
    opened.close();
  }
}

export const command: Command = {
  name: 'tmux',
  summary: 'inspect and drive tmux windows and panes on a device',
  usage: [
    'Usage: vibeterm tmux <subcommand> <target> [args] [options]',
    '',
    `Target: ${TARGET_HINT}`,
    '  <node> is a node id or name (default: --node, else the entry itself)',
    '  <window> is @id, an index or a name; <pane> is %id, an index or a name',
    '  omit the window/pane part to use the active one',
    '',
    'Subcommands:',
    '  ls <target>                     session tree (windows and panes)',
    '  windows <target>                list windows',
    '  panes <target> [--all]          list the panes of the located window',
    '  new-window <target> [name]      create a window (--name, --cwd)',
    '  kill-window <target>            close the located window',
    '  rename-window <target> <name>   rename the located window',
    '  split <target>                  split the located pane (--horizontal | --vertical)',
    '  kill-pane <target>              close the located pane',
    '  select <target>                 make the located window active',
    '  focus <target>                  make the located pane active',
    '  resize <target> <cols>x<rows>   resize the located pane',
    '  rename-pane <target> <name>     rename the located pane',
    '',
    'Options:',
    '  --name <name>      name for new-window / rename-window / rename-pane',
    '  --cwd <path>       working directory for new-window / split',
    '  --horizontal       split left|right (tmux split-window -h)',
    '  --vertical         split top|bottom (default)',
    '  --all              panes: list every pane of the session',
    '  --timeout <ms>     how long to wait for the change to land (default 30000)',
    '',
    'JSON (--json):',
    '  ls        TmuxSession[] (one entry: the session of this device)',
    '  windows   TmuxWindow[] (each with its panes)',
    '  panes     TmuxPane[]',
    '  others    {"ok":true,"action":"...","window"|"pane"|"id":...}',
    '',
    'Examples:',
    '  vibeterm tmux ls self/laptop',
    '  vibeterm tmux new-window self/laptop --name build',
    '  vibeterm tmux split self/laptop:build.0 --horizontal',
    '',
    'Exit codes: 3 when the node needs a login, 4 for an unknown node/device/window/pane,',
    '5 when the change does not land before --timeout.',
  ].join('\n'),
  flags: FLAGS,
  run,
};
