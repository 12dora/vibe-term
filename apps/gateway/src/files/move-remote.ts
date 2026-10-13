// ssh 设备的移动 / 重命名：一次 ssh 往返跑完整批，脚本逐项打印 `VTOP <index> <status>`。
// 所有路径参数经 quoteShellArg 单引号包裹；源条目 cd 到其真实父目录后以 `./<name>` 寻址，
// 因此以 `-` 开头的名字也安全，且最后一段永不被解引用。

import type { Device, FileErrorCode } from '@vibeterm/shared';
import { quoteShellArg } from '../tmux-client/command-builder';
import { type SshExecResult, execSshCommand } from './directory-browse';
import type { MoveBatch, MoveItem, MoveOutcome } from './move-types';
import {
  type DeviceRsyncHooks,
  type FileOpResult,
  fail,
  ok,
  withDeviceRsync,
} from './rsync-operation';
import type { RsyncDeviceSpec } from './ssh-command';

const MOVE_TIMEOUT_MS = 60_000;
/** 单次 ssh 命令里逐项调用文本的字节预算（远小于内核单参数 128 KiB 上限）。 */
const CHUNK_BUDGET_CHARS = 60_000;
const STATUS_MARKER = 'VTOP ';

const EXIT_CODES: Readonly<Record<number, FileErrorCode>> = {
  60: 'root_not_found',
  61: 'not_found',
  62: 'not_a_directory',
  63: 'permission_denied',
  64: 'outside_roots',
};

const ITEM_CODES: ReadonlySet<string> = new Set<string>([
  'not_found',
  'outside_roots',
  'invalid',
  'already_exists',
  'permission_denied',
  'not_a_directory',
  'unknown',
]);

export type MoveStatus = 'ok' | FileErrorCode;

/** 测试注入点：ssh 执行器与 `withDeviceRsync` 的 hooks（跳过真实 buildSpec）。 */
export const fileMoveRemoteIo: { exec: typeof execSshCommand; hooks: DeviceRsyncHooks } = {
  exec: execSshCommand,
  hooks: {},
};

const SCRIPT_FUNCTIONS = [
  'inside() { case "$1" in "$2"|"$2"/*) return 0;; esac; [ "$2" = / ]; }',
  'nodir() { [ -L "$1" ] || [ ! -d "$1" ]; }',
  'vt() {',
  'i=$1; p=$2; n=$3; dn=$4',
  '[ -e "$p" ] || { echo "VTOP $i not_found"; return 0; }',
  '[ -d "$p" ] || { echo "VTOP $i not_a_directory"; return 0; }',
  'cd -- "$p" || { echo "VTOP $i permission_denied"; return 0; }',
  'pr=$(pwd -P)',
  'inside "$pr" "$sr" || { echo "VTOP $i outside_roots"; return 0; }',
  's="./$n"',
  'if [ ! -e "$s" ] && [ ! -L "$s" ]; then echo "VTOP $i not_found"; return 0; fi',
  'if [ "$pr" = "$ddir" ] && [ "$n" = "$dn" ]; then echo "VTOP $i ok"; return 0; fi',
  'dp="${ddir%/}/$dn"',
  'if [ -d "$s" ] && [ ! -L "$s" ]; then',
  'case "${ddir%/}/" in "${pr%/}/$n"/*) echo "VTOP $i invalid"; return 0;; esac',
  'fi',
  'if [ -e "$dp" ] || [ -L "$dp" ]; then',
  'if [ "$ow" = 1 ] && nodir "$s" && nodir "$dp"; then',
  // 目标是指向目录的符号链接时 mv 会把源移进去，先只删链接本身
  'if [ -L "$dp" ]; then rm -f -- "$dp" || { echo "VTOP $i permission_denied"; return 0; }; fi',
  'else echo "VTOP $i already_exists"; return 0; fi',
  'fi',
  'if e=$(mv -f -- "$s" "$dp" 2>&1); then echo "VTOP $i ok"; else',
  'case "$e" in *ermission*) echo "VTOP $i permission_denied";; *) echo "VTOP $i unknown";; esac',
  'fi',
  '}',
];

function itemCall(item: MoveItem, index: number): string {
  const q = quoteShellArg;
  return `vt ${index} ${q(item.parent)} ${q(item.name)} ${q(item.destName)}`;
}

/** 脚本正文（未外包 `sh -c`）。退出码 60-64 为请求级错误，见 EXIT_CODES。 */
export function buildMoveScript(batch: MoveBatch): string {
  const q = quoteShellArg;
  const lines = [
    ...SCRIPT_FUNCTIONS,
    `cd -- ${q(batch.rootPath)} || exit 60`,
    'sr=$(pwd -P)',
    `cd -- ${q(batch.destRootPath)} || exit 60`,
    'dr=$(pwd -P)',
    `[ -e ${q(batch.destDir)} ] || exit 61`,
    `[ -d ${q(batch.destDir)} ] || exit 62`,
    `cd -- ${q(batch.destDir)} || exit 63`,
    'ddir=$(pwd -P)',
    'inside "$ddir" "$dr" || exit 64',
    `ow=${batch.overwrite ? 1 : 0}`,
    ...batch.items.map((item, index) => itemCall(item, index)),
  ];
  return lines.join('\n');
}

/** 远端登录 shell 未必是 POSIX sh，统一外包一层 `sh -c`。 */
export function buildMoveCommand(batch: MoveBatch): string {
  return `sh -c ${quoteShellArg(buildMoveScript(batch))}`;
}

function toStatus(word: string): MoveStatus {
  if (word === 'ok') return 'ok';
  return ITEM_CODES.has(word) ? (word as FileErrorCode) : 'unknown';
}

export function parseMoveOutput(stdout: Uint8Array): Map<number, MoveStatus> {
  const statuses = new Map<number, MoveStatus>();
  for (const line of new TextDecoder().decode(stdout).split('\n')) {
    if (!line.startsWith(STATUS_MARKER)) continue;
    const match = /^(\d+) ([a-z_]+)\s*$/.exec(line.slice(STATUS_MARKER.length));
    if (!match) continue;
    statuses.set(Number(match[1]), toStatus(match[2]));
  }
  return statuses;
}

/** 缺失状态行的条目一律 `unknown`。 */
export function outcomesFromStatuses(
  statuses: ReadonlyMap<number, MoveStatus>,
  count: number
): MoveOutcome[] {
  const outcomes: MoveOutcome[] = [];
  for (let index = 0; index < count; index++) {
    const status = statuses.get(index) ?? 'unknown';
    outcomes.push(status === 'ok' ? ok(undefined) : fail(status));
  }
  return outcomes;
}

function classifyExit(res: SshExecResult): FileOpResult<never> {
  if (res.exitCode === 124) return fail('timeout', res.stderr);
  if (res.exitCode === 255) return fail('connection_failed', res.stderr);
  return fail(EXIT_CODES[res.exitCode] ?? 'unknown', res.stderr);
}

/** 按调用文本体量切批，避免超出 ssh 命令行参数上限；常规请求只有一批。 */
export function splitMoveBatch(batch: MoveBatch, budget = CHUNK_BUDGET_CHARS): MoveBatch[] {
  const chunks: MoveBatch[] = [];
  let current: MoveItem[] = [];
  let size = 0;
  for (const item of batch.items) {
    const len = itemCall(item, 0).length;
    if (current.length > 0 && size + len > budget) {
      chunks.push({ ...batch, items: current });
      current = [];
      size = 0;
    }
    current.push(item);
    size += len;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push({ ...batch, items: current });
  return chunks;
}

async function runChunk(
  spec: RsyncDeviceSpec,
  chunk: MoveBatch
): Promise<FileOpResult<MoveOutcome[]>> {
  const res = await fileMoveRemoteIo.exec(spec, buildMoveCommand(chunk), MOVE_TIMEOUT_MS);
  if (res.exitCode !== 0) return classifyExit(res);
  return ok(outcomesFromStatuses(parseMoveOutput(res.stdout), chunk.items.length));
}

export function moveRemote(device: Device, batch: MoveBatch): Promise<FileOpResult<MoveOutcome[]>> {
  return withDeviceRsync<MoveOutcome[]>(
    device,
    async (spec) => {
      const outcomes: MoveOutcome[] = [];
      for (const [index, chunk] of splitMoveBatch(batch).entries()) {
        const res = await runChunk(spec, chunk);
        // 首批失败 = 请求级错误；后续批失败只标记其所属条目，已移动的不丢结果
        if (!res.ok && index === 0) return res;
        if (res.ok) outcomes.push(...res.data);
        else outcomes.push(...chunk.items.map(() => res));
      }
      return ok(outcomes);
    },
    fileMoveRemoteIo.hooks
  );
}
