// ssh 设备的移动 / 重命名：一次 ssh 往返跑完整批，脚本逐项打印 `VTOP <index> <status>`。
// 脚本走 stdin 交给 `sh -s`（无 argv 长度上限）；所有路径参数经 quoteShellArg 单引号包裹，
// 源条目 cd 到其物理父目录后以 `./<name>` 寻址，因此以 `-` 开头的名字也安全，且最后一段永不被解引用。

import type { Device, FileErrorCode } from '@vibeterm/shared';
import { quoteShellArg } from '../tmux-client/command-builder';
import type { MoveBatch, MoveItem, MoveOutcome } from './move-types';
import {
  type RemoteScriptResult,
  SH_INSIDE_FN,
  SH_PHYS_FN,
  execRemoteScript,
} from './remote-script';
import {
  type DeviceRsyncHooks,
  type FileOpResult,
  fail,
  ok,
  withDeviceRsync,
} from './rsync-operation';

const MOVE_TIMEOUT_MS = 60_000;
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

/** 测试注入点：脚本执行器与 `withDeviceRsync` 的 hooks（跳过真实 buildSpec）。 */
export const fileMoveRemoteIo: { exec: typeof execRemoteScript; hooks: DeviceRsyncHooks } = {
  exec: execRemoteScript,
  hooks: {},
};

// 约定：脚本里所有可能读 stdin 的命令都带 `</dev/null`，否则会吃掉 `sh -s` 还没读到的脚本正文。
//
// 不覆盖语义：`mv -n` 不替换已存在的目标，结果由「源是否还在」加退出码与 stderr 共同判定
// （新版 GNU 在跳过时返回非零并提示 not replacing，旧版 GNU / BSD 静默返回零）。纯 POSIX 工具
// 无法彻底消除的残余风险：目标在检查与 mv 之间被换成「指向目录的符号链接」时，mv 会把源移进那个
// 目录；`mv -T` 只有 GNU 有，所以探测到 GNU 才加 `-T`（变量 T），BSD / busybox 上保留这个极窄的窗口。
const SCRIPT_FUNCTIONS = [
  SH_PHYS_FN,
  SH_INSIDE_FN,
  'nodir() { [ -L "$1" ] || [ ! -d "$1" ]; }',
  'gone() { [ ! -e "$1" ] && [ ! -L "$1" ]; }',
  // fe：把 mv / rm 的 stderr 映射成状态词
  'fe() { case "$1" in',
  '*ermission*|*not\\ permitted*) echo permission_denied;;',
  '*) echo unknown;;',
  'esac; }',
  // mvn <dest> [1]：不覆盖地把 ./$s 移到 dest，结果放进 st。
  // 第二个参数为 1 表示调用方在本项内已确认 dest 原先不存在：此时 mv 失败（如跨文件系统复制到一半
  // ENOSPC）留下的半成品才可以删；stderr 为空（静默跳过）或提示源删不掉（源可能只剩一半，
  // 目标是唯一完整的副本）时一律不删
  'mvn() {',
  'e=$(mv -n $T -- "$s" "$1" 2>&1 </dev/null); rc=$?',
  'if gone "$s"; then st=ok; return 0; fi',
  'if [ "$rc" -eq 0 ]; then st=already_exists; return 1; fi',
  'case "$e" in',
  '*not\\ replacing*|*File\\ exists*) st=already_exists; return 1;;',
  '*ermission*|*not\\ permitted*) st=permission_denied;;',
  '*) st=unknown;;',
  'esac',
  'case "$e" in *cannot\\ remove*) return 1;; esac',
  'if [ "$2" = 1 ] && [ -n "$e" ]; then rm -rf -- "$1" 2>/dev/null </dev/null; fi',
  'return 1',
  '}',
  // mvo：覆盖已存在的非目录目标，结果放进 st。
  // GNU（T 非空）：一次 `mv -f -T` 即 rename(2)，原子替换目标目录项（符号链接也一样），
  // 不暂存、不预删，失败时旧目标原样保留。
  // 非 GNU 且目标是符号链接：没有 -T，直接 mv 会把源移进链接指向的目录，只能先把源挪到目标目录内的
  // 临时名（失败则什么都没丢），再 rm 旧链接 + mv 临时项；rm 之后到 mv 成功之前有一个无法避免的窗口，
  // 此时 mv 失败就把临时项放回源位置，但旧链接已经没了
  'mvo() {',
  'if [ -n "$T" ] || [ ! -L "$dp" ]; then',
  'if e=$(mv -f $T -- "$s" "$dp" 2>&1 </dev/null); then st=ok; else st=$(fe "$e"); fi',
  'return 0',
  'fi',
  'tp="${ddir%/}/.vtmv.$$.$i"',
  'gone "$tp" || { st=unknown; return 1; }',
  'mvn "$tp" 1 || return 1',
  'if e=$(rm -f -- "$dp" 2>&1 </dev/null) && e=$(mv -f -- "$tp" "$dp" 2>&1 </dev/null); then',
  'st=ok; return 0',
  'fi',
  'st=$(fe "$e")',
  // 源位置已被占用（可能是指向目录的符号链接）就不动临时项，宁可留下数据也不当容器用
  'if gone "$s"; then mv -n $T -- "$tp" "$s" 2>/dev/null </dev/null; fi',
  'gone "$tp" || st=unknown',
  'return 1',
  '}',
  'vt() {',
  'i=$1; p=$2; n=$3; dn=$4',
  '[ -e "$p" ] || { echo "VTOP $i not_found"; return 0; }',
  '[ -d "$p" ] || { echo "VTOP $i not_a_directory"; return 0; }',
  'cd -- "$p" || { echo "VTOP $i permission_denied"; return 0; }',
  'phys || { echo "VTOP $i permission_denied"; return 0; }',
  'pr=$PHYS',
  'inside "$pr" "$sr" || { echo "VTOP $i outside_roots"; return 0; }',
  's="./$n"',
  'if gone "$s"; then echo "VTOP $i not_found"; return 0; fi',
  'if [ "$pr" = "$ddir" ] && [ "$n" = "$dn" ]; then echo "VTOP $i ok"; return 0; fi',
  'dp="${ddir%/}/$dn"',
  'if [ -d "$s" ] && [ ! -L "$s" ]; then',
  'case "${ddir%/}/" in "${pr%/}/$n"/*) echo "VTOP $i invalid"; return 0;; esac',
  'fi',
  'st=unknown',
  'if gone "$dp"; then mvn "$dp" 1',
  'elif [ "$ow" = 1 ] && nodir "$s" && nodir "$dp"; then mvo',
  'else st=already_exists; fi',
  'echo "VTOP $i $st"',
  '}',
];

function itemCall(item: MoveItem, index: number): string {
  const q = quoteShellArg;
  return `vt ${index} ${q(item.parent)} ${q(item.name)} ${q(item.destName)}`;
}

/** 脚本正文。退出码 60-64 为请求级错误，见 EXIT_CODES。 */
export function buildMoveScript(batch: MoveBatch): string {
  const q = quoteShellArg;
  const lines = [
    ...SCRIPT_FUNCTIONS,
    'T=',
    'if mv --help </dev/null 2>&1 | grep -q -- --no-target-directory; then T=-T; fi',
    `cd -- ${q(batch.rootPath)} || exit 60`,
    'phys || exit 60',
    'sr=$PHYS',
    `cd -- ${q(batch.destRootPath)} || exit 60`,
    'phys || exit 60',
    'dr=$PHYS',
    `[ -e ${q(batch.destDir)} ] || exit 61`,
    `[ -d ${q(batch.destDir)} ] || exit 62`,
    `cd -- ${q(batch.destDir)} || exit 63`,
    'phys || exit 63',
    'ddir=$PHYS',
    'inside "$ddir" "$dr" || exit 64',
    `ow=${batch.overwrite ? 1 : 0}`,
    ...batch.items.map((item, index) => itemCall(item, index)),
  ];
  return lines.join('\n');
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

function classifyExit(res: RemoteScriptResult): FileOpResult<never> {
  if (res.exitCode === 124) return fail('timeout', res.stderr);
  if (res.exitCode === 255) return fail('connection_failed', res.stderr);
  return fail(EXIT_CODES[res.exitCode] ?? 'unknown', res.stderr);
}

export function moveRemote(device: Device, batch: MoveBatch): Promise<FileOpResult<MoveOutcome[]>> {
  return withDeviceRsync<MoveOutcome[]>(
    device,
    async (spec) => {
      const res = await fileMoveRemoteIo.exec(spec, buildMoveScript(batch), MOVE_TIMEOUT_MS);
      if (res.exitCode !== 0) return classifyExit(res);
      return ok(outcomesFromStatuses(parseMoveOutput(res.stdout), batch.items.length));
    },
    fileMoveRemoteIo.hooks
  );
}
