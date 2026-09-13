// `term run`：往 pane 打命令、采集输出、可选临时窗口。

import { readFile } from 'node:fs/promises';
import { type TmuxPane, type TmuxSession, type TmuxWindow, wsBorsh } from '@vibeterm/shared';
import { type FlagValues, flagBool, flagNumber } from './args';
import type { CliContext } from './context';
import { NetworkError, UsageError, errorText } from './errors';
import { readAllStdin } from './prompt';
import {
  type ByteCollector,
  IdleWatcher,
  type RunSentinel,
  createRunSentinel,
  formatRunOutput,
} from './term-collect';
import {
  type OpenedDeviceSession,
  applyTmuxChange,
  firstNew,
  windowById,
  windowIds,
} from './tmux-ops';
import { stripAnsi } from './vt-text';

const DEFAULT_RUN_IDLE_MS = 800;
const PANE_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'login',
  'tmux',
]);

export interface TermRunStream {
  open(target: string): Promise<{
    opened: OpenedDeviceSession;
    window: TmuxWindow;
    pane: TmuxPane;
  }>;
  retarget(window: TmuxWindow, pane: TmuxPane): void;
  screen(): Promise<unknown>;
  sendInput(data: string): void;
  attachWatcher(watcher: IdleWatcher | null): void;
  onData(hook: () => void): () => void;
  output: ByteCollector;
  throwIfFailed(): void;
  abort(): void;
}

interface RunResult {
  output: string;
  raw: Uint8Array;
  reason: string;
  exitCode: number | null;
}

export function isPaneShell(command: string | null | undefined): boolean {
  if (!command) return true;
  const base = command.trim().replace(/^-+/, '').split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return PANE_SHELLS.has(base);
}

export function wantRunJson(ctx: CliContext, flags: FlagValues): boolean {
  if (ctx.globals.json) return true;
  if (flagBool(flags, 'no-json')) return false;
  return !ctx.out.isStdoutTty();
}

function timeoutOf(ctx: CliContext): number {
  return ctx.globals.timeoutMs;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function requireSingleLine(commandLine: string): string {
  if (!/[\r\n]/.test(commandLine)) return commandLine;
  throw new UsageError(
    'vibeterm term run takes a single line',
    'send multi-line input with --stdin, @file, or: vibeterm term send --stdin'
  );
}

function normalizePasteScript(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/, '');
}

export async function resolveRunBody(
  flags: FlagValues,
  rest: string[]
): Promise<{
  commandLine: string;
  paste: boolean;
}> {
  if (flagBool(flags, 'stdin')) {
    if (rest.length > 0) {
      throw new UsageError('vibeterm term run --stdin does not take a command argument');
    }
    const text = normalizePasteScript(await readAllStdin());
    if (!text) throw new UsageError('vibeterm term run --stdin got an empty body');
    return { commandLine: text, paste: true };
  }
  const at = rest.length === 1 && rest[0].startsWith('@') ? rest[0].slice(1) : null;
  if (at !== null) {
    if (!at) throw new UsageError('@file path is empty');
    const text = normalizePasteScript(await readFile(at, 'utf8'));
    if (!text) throw new UsageError(`@${at} is empty`);
    return { commandLine: text, paste: true };
  }
  const commandLine = requireSingleLine(rest.join(' ').trim());
  if (!commandLine) throw new UsageError('vibeterm term run needs a command to run');
  return { commandLine, paste: false };
}

function assertPaneIdle(pane: TmuxPane, force: boolean): void {
  if (force || isPaneShell(pane.currentCommand)) return;
  const cmd = pane.currentCommand ?? '?';
  throw new UsageError(`目标 pane 正在运行 ${cmd}；用 --ephemeral 开新窗口，或用 vibeterm exec`);
}

function ephemeralName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `vt-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function hasEphemeralWindow(tree: TmuxSession, name: string, before: Set<string>): boolean {
  if (tree.windows.some((window) => window.name === name)) return true;
  return firstNew(before, windowIds(tree)) !== null;
}

function isUnknownKindError(error: unknown): boolean {
  if (error instanceof wsBorsh.WsBorshError) return error.code === wsBorsh.ERROR_UNKNOWN_KIND;
  return error instanceof Error && /unknown message kind/i.test(error.message);
}

function throwEphemeralCreateError(error: unknown): never {
  if (isUnknownKindError(error)) {
    throw new NetworkError('该节点版本过旧，不支持 --ephemeral');
  }
  throw error;
}

interface EphemeralSlot {
  name: string;
  id: string | null;
}

async function createEphemeralWindow(
  opened: OpenedDeviceSession,
  timeoutMs: number,
  slot: EphemeralSlot
): Promise<{ window: TmuxWindow; pane: TmuxPane }> {
  slot.name = ephemeralName();
  const before = windowIds(opened.tree);
  let tree: TmuxSession;
  try {
    tree = await applyTmuxChange(
      opened,
      { type: 'create-window', deviceId: opened.device.id, name: slot.name, detached: true },
      (next) => hasEphemeralWindow(next, slot.name, before),
      'the ephemeral window to appear',
      timeoutMs
    );
  } catch (error) {
    throwEphemeralCreateError(error);
  }
  const created = tree.windows.find((window) => window.name === slot.name);
  const window = created ?? windowById(tree, firstNew(before, windowIds(tree)) ?? '');
  if (!window) throw new UsageError('ephemeral window vanished before it could be used');
  slot.id = window.id;
  const pane = window.panes.find((item) => item.active) ?? window.panes[0];
  if (!pane) throw new UsageError(`ephemeral window ${window.id} has no pane`);
  return { window, pane };
}

function ephemeralLabel(opened: OpenedDeviceSession, slot: EphemeralSlot): string {
  if (slot.id) return slot.id;
  const id = opened.session.session()?.windows.find((window) => window.name === slot.name)?.id;
  return id ?? slot.name;
}

async function closeEphemeralWindow(
  ctx: CliContext,
  opened: OpenedDeviceSession,
  slot: EphemeralSlot | null
): Promise<void> {
  if (!slot) return;
  const windowId =
    slot.id ?? opened.session.session()?.windows.find((window) => window.name === slot.name)?.id;
  if (!windowId) return;
  try {
    await applyTmuxChange(
      opened,
      { type: 'close-window', deviceId: opened.device.id, windowId },
      (next) => !windowIds(next).has(windowId),
      `ephemeral window ${windowId} to close`,
      timeoutOf(ctx)
    );
  } catch (error) {
    const label = ephemeralLabel(opened, slot);
    ctx.out.warn(`failed to close ephemeral window ${label}: ${errorText(error)}`);
  }
}

function installRunSignals(onInterrupt: () => void): () => void {
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  };
}

function pasteBlock(script: string): string {
  return `\x1b[200~${script}\x1b[201~\r`;
}

function tailText(bytes: Uint8Array, window = 4096): string {
  return stripAnsi(bytes.length > window ? bytes.subarray(bytes.length - window) : bytes);
}

function waitQuiet(stream: TermRunStream, idleMs: number, remainingMs: number): Promise<string> {
  const watcher = new IdleWatcher({ idleMs, timeoutMs: Math.max(1, remainingMs) });
  stream.attachWatcher(watcher);
  return watcher.wait().finally(() => stream.attachWatcher(null));
}

async function waitSentinel(
  stream: TermRunStream,
  sentinel: RunSentinel,
  remainingMs: number,
  send: () => void
): Promise<string> {
  const watcher = new IdleWatcher({ idleMs: 0, timeoutMs: Math.max(1, remainingMs) });
  const check = (): void => {
    if (sentinel.find(tailText(stream.output.bytes()))) watcher.done();
  };
  stream.attachWatcher(watcher);
  const stop = stream.onData(check);
  try {
    send();
    check();
    return await watcher.wait();
  } finally {
    stop();
    stream.attachWatcher(null);
  }
}

async function collectRun(
  ctx: CliContext,
  stream: TermRunStream,
  input: { commandLine: string; sentinel: RunSentinel | null; flags: FlagValues; paste: boolean }
): Promise<RunResult> {
  const idleMs = Math.max(0, flagNumber(input.flags, 'idle') ?? DEFAULT_RUN_IDLE_MS);
  const deadline = Date.now() + timeoutOf(ctx);
  stream.output.reset();
  stream.sendInput(input.paste ? pasteBlock(input.commandLine) : `${input.commandLine}\r`);
  let reason = await waitQuiet(stream, idleMs, deadline - Date.now());
  if (input.sentinel && reason === 'idle') {
    reason = await waitSentinel(stream, input.sentinel, deadline - Date.now(), () =>
      stream.sendInput(`${input.sentinel?.line}\r`)
    );
  }
  stream.throwIfFailed();
  const raw = stream.output.bytes();
  const hit = input.sentinel?.find(stripAnsi(raw)) ?? null;
  return {
    raw,
    output: formatRunOutput(raw, {
      command: input.commandLine,
      sentinel: input.sentinel,
      paste: input.paste,
    }),
    reason: stream.output.truncated ? 'truncated' : reason,
    exitCode: hit ? hit.exitCode : null,
  };
}

function printRun(
  ctx: CliContext,
  flags: FlagValues,
  asJson: boolean,
  paneId: string,
  result: RunResult & { command: string }
): void {
  if (asJson) {
    ctx.out.line(
      JSON.stringify({
        pane: paneId,
        command: result.command,
        reason: result.reason,
        exitCode: result.exitCode,
        output: result.output,
        raw: base64(result.raw),
      })
    );
    return;
  }
  if (flagBool(flags, 'raw')) {
    ctx.out.raw(result.raw);
    return;
  }
  if (result.output) ctx.out.line(result.output);
  if (result.exitCode !== null) ctx.out.info(`exit code: ${result.exitCode}`);
  if (result.reason === 'timeout') ctx.out.warn('output was still arriving when --timeout hit');
  if (result.reason === 'truncated') ctx.out.warn('output hit the 8 MiB cap and was truncated');
}

export async function runTermCommand(
  ctx: CliContext,
  flags: FlagValues,
  rest: string[],
  stream: TermRunStream
): Promise<number> {
  const target = rest[0];
  if (!target) throw new UsageError('vibeterm term run needs a target');
  const body = await resolveRunBody(flags, rest.slice(1));
  const asJson = wantRunJson(ctx, flags);
  const { opened, pane: initialPane } = await stream.open(target);
  let ephemeral: EphemeralSlot | null = null;
  const dropSignals = installRunSignals(() => stream.abort());
  try {
    let pane = initialPane;
    if (flagBool(flags, 'ephemeral')) {
      ephemeral = { name: '', id: null };
      const created = await createEphemeralWindow(opened, timeoutOf(ctx), ephemeral);
      stream.retarget(created.window, created.pane);
      pane = created.pane;
    } else {
      assertPaneIdle(initialPane, flagBool(flags, 'force'));
    }
    await stream.screen();
    const sentinel = flagBool(flags, 'marker') ? createRunSentinel() : null;
    const result = await collectRun(ctx, stream, {
      commandLine: body.commandLine,
      sentinel,
      flags,
      paste: body.paste,
    });
    printRun(ctx, flags, asJson, pane.id, { ...result, command: body.commandLine });
    const incomplete = result.reason === 'timeout' || result.reason === 'truncated';
    return incomplete && !flagBool(flags, 'allow-timeout') ? 1 : 0;
  } finally {
    dropSignals();
    await closeEphemeralWindow(ctx, opened, ephemeral);
    opened.close();
  }
}
