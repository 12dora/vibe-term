import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { errorMessage } from '@tmex/shared';
import type { BrowseDirectoryEntryDto, BrowseDirectoryResponse, Device } from '@tmex/shared';
import { getDeviceById } from '../db';
import { quoteShellArg } from '../tmux-client/command-builder';
import { MAX_ENTRIES } from './categorize';
import { classifyRsyncFailure } from './rsync';
import {
  type DeviceRsyncHooks,
  type FileOpResult,
  fail,
  ok,
  withDeviceRsync,
} from './rsync-operation';
import type { RsyncDeviceSpec } from './ssh-command';

const posix = path.posix;
const BROWSE_TIMEOUT_MS = 20_000;

export type SshExecResult = {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
};

export type DirectoryBrowseDeps = {
  getDevice?: (id: string) => Device | null;
  enqueue?: DeviceRsyncHooks['enqueue'];
  buildSpec?: DeviceRsyncHooks['buildSpec'];
  execSsh?: (spec: RsyncDeviceSpec, command: string, timeoutMs?: number) => Promise<SshExecResult>;
};

function parentOf(absPath: string): string | null {
  if (absPath === '/') return null;
  return posix.dirname(absPath);
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

function sortBrowseEntries(entries: BrowseDirectoryEntryDto[]): void {
  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

function capEntries(entries: BrowseDirectoryEntryDto[]): {
  entries: BrowseDirectoryEntryDto[];
  truncated: boolean;
} {
  const truncated = entries.length > MAX_ENTRIES;
  return { entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated };
}

function mapNodeFsError(err: unknown): FileOpResult<never> {
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === 'ENOENT') return fail('not_found');
  if (code === 'ENOTDIR') return fail('not_a_directory');
  if (code === 'EACCES' || code === 'EPERM') return fail('permission_denied');
  if (code === 'ETIMEDOUT') return fail('timeout');
  return fail('unknown');
}

function normalizeRequestedPath(raw: string): FileOpResult<string | null> {
  const trimmed = raw.trim();
  if (trimmed === '') return ok(null);
  if (trimmed.startsWith('~') || !trimmed.startsWith('/')) return fail('invalid');
  return ok(posix.resolve(trimmed));
}

function toResponse(absPath: string, entries: BrowseDirectoryEntryDto[]): BrowseDirectoryResponse {
  sortBrowseEntries(entries);
  const capped = capEntries(entries);
  return {
    path: absPath,
    parent: parentOf(absPath),
    entries: capped.entries,
    truncated: capped.truncated,
  };
}

async function browseLocal(
  absPath: string,
  includeHidden: boolean
): Promise<FileOpResult<BrowseDirectoryResponse>> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(absPath);
  } catch (err) {
    return mapNodeFsError(err);
  }
  if (!st.isDirectory()) return fail('not_a_directory');

  let dirents: Dirent[];
  try {
    dirents = await readdir(absPath, { withFileTypes: true });
  } catch (err) {
    return mapNodeFsError(err);
  }

  const entries: BrowseDirectoryEntryDto[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (name === '.' || name === '..') continue;
    const hidden = isHiddenName(name);
    if (hidden && !includeHidden) continue;
    const childPath = posix.join(absPath, name);
    try {
      let symlink = dirent.isSymbolicLink();
      let isDir = dirent.isDirectory();
      if (symlink || (!isDir && !dirent.isFile())) {
        const followed = await stat(childPath);
        isDir = followed.isDirectory();
        if (!symlink) symlink = dirent.isSymbolicLink();
      }
      if (!isDir) continue;
      entries.push({ name, path: childPath, hidden, symlink });
    } catch {
      // 无法 stat 的条目跳过（含悬空符号链接）
    }
  }
  return ok(toResponse(absPath, entries));
}

// 远端 stdout：P<resolved>\0 后跟成对的 <d|l>\0<basename>\0（POSIX sh 循环输出，不依赖 GNU find）
function parseSshListing(stdout: Uint8Array): {
  path: string;
  items: Array<{ type: 'd' | 'l'; name: string }>;
} | null {
  const text = new TextDecoder().decode(stdout);
  const tokens = text.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
  if (tokens.length === 0) return null;
  const header = tokens[0];
  if (!header.startsWith('P')) return null;
  const resolved = posix.resolve(header.slice(1));
  if (!resolved.startsWith('/')) return null;
  const items: Array<{ type: 'd' | 'l'; name: string }> = [];
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const type = tokens[i];
    const name = posix.basename(tokens[i + 1] ?? '');
    if ((type !== 'd' && type !== 'l') || !name || name === '.' || name === '..') continue;
    items.push({ type, name });
  }
  return { path: resolved, items };
}

function classifyBrowseSsh(exitCode: number, stderr: string): ReturnType<typeof fail> {
  const trimmed = stderr.trim();
  if (exitCode === 2 || trimmed === 'not_found') return fail('not_found');
  if (exitCode === 20 || trimmed === 'not_a_directory') return fail('not_a_directory');
  return fail(classifyRsyncFailure(exitCode, stderr), stderr);
}

export function buildSshBrowseCommand(absPath: string | null): string {
  const assign = absPath === null ? 'target="${HOME:-/}"' : `target=${quoteShellArg(absPath)}`;
  return [
    assign,
    'if [ ! -e "$target" ]; then echo not_found >&2; exit 2; fi',
    'if [ ! -d "$target" ]; then echo not_a_directory >&2; exit 20; fi',
    'printf \'P%s\\0\' "$target"',
    'cd "$target" || exit 1',
    'for f in .* *; do [ "$f" = . ] && continue; [ "$f" = .. ] && continue; if [ -L "$f" ]; then [ -d "$f" ] && printf \'l\\0%s\\0\' "$f"; elif [ -d "$f" ]; then printf \'d\\0%s\\0\' "$f"; fi; done',
  ].join('; ');
}

export async function execSshCommand(
  spec: RsyncDeviceSpec,
  command: string,
  timeoutMs = BROWSE_TIMEOUT_MS
): Promise<SshExecResult> {
  if (!spec.rsh) {
    return { stdout: new Uint8Array(), stderr: 'not an ssh device', exitCode: 255 };
  }
  const dest = spec.targetPrefix.replace(/:$/, '');
  const argv = [...spec.rsh.split(' '), dest, command];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, spec.env);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
  } catch (err) {
    return {
      stdout: new Uint8Array(),
      stderr: errorMessage(err),
      exitCode: 255,
    };
  }

  let timedOut = false;
  const killProc = () => {
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killProc();
  }, timeoutMs);

  try {
    const [stdoutBuf, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return {
        stdout: new Uint8Array(stdoutBuf),
        stderr: `${stderr}\n[tmex] ssh timed out`,
        exitCode: 124,
      };
    }
    return { stdout: new Uint8Array(stdoutBuf), stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

export const directoryBrowseIo = {
  execSsh: execSshCommand,
};

async function browseSsh(
  spec: RsyncDeviceSpec,
  absPath: string | null,
  includeHidden: boolean,
  execSsh: NonNullable<DirectoryBrowseDeps['execSsh']>
): Promise<FileOpResult<BrowseDirectoryResponse>> {
  const res = await execSsh(spec, buildSshBrowseCommand(absPath), BROWSE_TIMEOUT_MS);
  if (res.exitCode !== 0) return classifyBrowseSsh(res.exitCode, res.stderr);

  const parsed = parseSshListing(res.stdout);
  if (!parsed) return fail('unknown', res.stderr);

  const entries: BrowseDirectoryEntryDto[] = [];
  for (const item of parsed.items) {
    const hidden = isHiddenName(item.name);
    if (hidden && !includeHidden) continue;
    entries.push({
      name: item.name,
      path: posix.join(parsed.path, item.name),
      hidden,
      symlink: item.type === 'l',
    });
  }
  return ok(toResponse(parsed.path, entries));
}

export async function browseDirectory(
  deviceId: string,
  inputPath: string,
  includeHidden: boolean,
  deps: DirectoryBrowseDeps = {}
): Promise<FileOpResult<BrowseDirectoryResponse>> {
  const getDevice = deps.getDevice ?? getDeviceById;
  const device = getDevice(deviceId);
  if (!device) return fail('device_not_found');

  const normalized = normalizeRequestedPath(inputPath);
  if (!normalized.ok) return normalized;

  if (device.type === 'local') {
    const absPath = normalized.data ?? posix.resolve(homedir());
    return browseLocal(absPath, includeHidden);
  }

  return withDeviceRsync(
    device,
    (spec) =>
      browseSsh(spec, normalized.data, includeHidden, deps.execSsh ?? directoryBrowseIo.execSsh),
    {
      enqueue: deps.enqueue,
      buildSpec: deps.buildSpec,
    }
  );
}
