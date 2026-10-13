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
// 脚本开头固定 `LC_ALL=C`：状态分类要匹配 mv / rm 的 stderr 文案，不能受远端 locale 影响。
//
// 每一项先判断「源所在目录」与「目标目录」是否同一文件系统（`df -P` 取设备+挂载点，取不到按不同处理）：
// - 同一文件系统：只有一次 rename(2)，不可能产生半成品。不覆盖用 `mv -n`，覆盖非目录目标用 `mv -f -T`
//   （GNU / BusyBox，原子替换目录项，符号链接目标也一样）。没有 `-T` 时普通文件目标用 `mv -f`；
//   符号链接目标只能「源挪到目标目录内的私有临时名 → rm 旧链接 → 再挪过去」，rm 之后到落位之前有一个
//   无法避免的窗口，落位前会再确认目标仍不存在，失败就把数据放回源位置。
// - 不同文件系统（mv 会复制）：绝不让 mv 直接写公开路径。先 `mv -n` 到目标目录内的私有临时项
//   `.vtmv.<pid>.<index>`（事先必须不存在），成功后再按同文件系统规则从临时项 rename 到目标；
//   提交不了（不覆盖时目标刚好出现，或最后一步失败）就在源位置仍空闲时把数据搬回源位置，否则保留临时项。
//
// 清理只会针对私有临时项：暂存失败且源还完整时 `rm -rf` 临时项；源已消失或只删了一半（stderr 含
// cannot remove）时临时项可能是唯一完整的副本，保留并报 unknown。任何路径都不会删除或半写公开路径。
//
// 残余窗口：没有 `-T` 的平台上，纯 POSIX 工具无法做「原子不覆盖」rename，目标在检查与 mv 之间被换成
// 「指向目录的符号链接」时 mv 会把源移进那个目录；脚本在暂存与提交之间被杀，数据会留在目标目录的
// `.vtmv.*` 里。`-T` 探测同时认 GNU 的 `--no-target-directory` 与 BusyBox help 里只列的短选项 `-T`。
const SCRIPT_FUNCTIONS = [
  SH_PHYS_FN,
  SH_INSIDE_FN,
  'nodir() { [ -L "$1" ] || [ ! -d "$1" ]; }',
  'gone() { [ ! -e "$1" ] && [ ! -L "$1" ]; }',
  'fsid() { df -P -- "$1" 2>/dev/null </dev/null | awk \'NR==2 { print $1 "|" $NF }\'; }',
  // samefs：源（及其父目录）与目标目录同一文件系统；任何一边取不到 id 都按不同处理
  'samefs() {',
  '_a=$(fsid .); [ -n "$_a" ] && [ "$_a" = "$DFS" ] || return 1',
  '[ -L "$s" ] && return 0',
  '_b=$(fsid "$s"); [ "$_b" = "$_a" ]',
  '}',
  // fe：把 mv / rm 的 stderr 映射成状态词
  'fe() { case "$1" in',
  '*ermission*|*not\\ permitted*) echo permission_denied;;',
  '*) echo unknown;;',
  'esac; }',
  // mvn <from> <to>：同目录或同文件系统内不覆盖地 rename，结果由「from 是否消失」判定，放进 st
  'mvn() {',
  'e=$(mv -n $T -- "$1" "$2" 2>&1 </dev/null)',
  'if gone "$1"; then st=ok; return 0; fi',
  'if ! gone "$2"; then st=already_exists; return 1; fi',
  'case "$e" in',
  '*not\\ replacing*|*File\\ exists*) st=already_exists;;',
  '*ermission*|*not\\ permitted*) st=permission_denied;;',
  '*) st=unknown;;',
  'esac',
  'return 1',
  '}',
  // stg：跨文件系统时把源暂存进目标目录内的私有临时项 tp（成功后 cur 指向 tp，sg=1）。
  // 失败只可能清理 tp 本身；源已消失、只删了一半或 tp 不是我们建的，一律保留现场
  'stg() {',
  'gone "$tp" || { st=unknown; return 1; }',
  'e=$(mv -n $T -- "$s" "$tp" 2>&1 </dev/null); rc=$?',
  'if [ "$rc" -eq 0 ] && gone "$s"; then sg=1; cur=$tp; return 0; fi',
  'st=unknown',
  'if [ "$rc" -eq 0 ]; then return 1; fi',
  'case "$e" in',
  '*not\\ replacing*|*File\\ exists*|*cannot\\ remove*|*can?t\\ remove*) return 1;;',
  'esac',
  'gone "$s" && return 1',
  'st=$(fe "$e")',
  'rm -rf -- "$tp" 2>/dev/null </dev/null',
  'return 1',
  '}',
  // back：数据在 tp 里时放回源位置；只在源位置仍空闲时才动，被占用就保留 tp（不把占用物当容器）
  'back() {',
  '[ "$sg" = 1 ] || return 0',
  'if gone "$s"; then mv -n $T -- "$tp" "$s" 2>/dev/null </dev/null; fi',
  'gone "$tp" || st=unknown',
  '}',
  // ovr：用 cur 替换已存在的非目录目标 dp，结果放进 st，失败返回非零（调用方负责 back）。
  // 有 -T（或目标不是符号链接）：一次 mv -f，目标目录项被原子替换，失败时旧目标原样保留。
  // 否则目标是符号链接：先把数据挪到 tp，rm 旧链接，确认 dp 仍不存在再用 mv -n 落位
  'ovr() {',
  'if [ -n "$T" ] || [ ! -L "$dp" ]; then',
  'if e=$(mv -f $T -- "$cur" "$dp" 2>&1 </dev/null); then st=ok; return 0; fi',
  'st=$(fe "$e"); return 1',
  'fi',
  'if [ "$sg" != 1 ]; then',
  'gone "$tp" || { st=unknown; return 1; }',
  'mvn "$s" "$tp" || return 1',
  'sg=1; cur=$tp',
  'fi',
  'e=$(rm -f -- "$dp" 2>&1 </dev/null) || { st=$(fe "$e"); return 1; }',
  'gone "$dp" || { st=already_exists; return 1; }',
  'mvn "$tp" "$dp"',
  '}',
  // put <n|o>：把 ./$s 落到 dp；n 不覆盖，o 覆盖非目录目标
  'put() {',
  'cur=$s; sg=0',
  'samefs || stg || return 1',
  'if [ "$1" = o ]; then ovr && return 0; else mvn "$cur" "$dp" && return 0; fi',
  'back',
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
  'tp="${ddir%/}/.vtmv.$$.$i"',
  'if [ -d "$s" ] && [ ! -L "$s" ]; then',
  'case "${ddir%/}/" in "${pr%/}/$n"/*) echo "VTOP $i invalid"; return 0;; esac',
  'fi',
  'st=unknown',
  'if gone "$dp"; then put n',
  'elif [ "$ow" = 1 ] && nodir "$s" && nodir "$dp"; then put o',
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
    'LC_ALL=C; export LC_ALL',
    ...SCRIPT_FUNCTIONS,
    'T=',
    "if mv --help </dev/null 2>&1 | grep -q -e '--no-target-directory' -e '-T'; then T=-T; fi",
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
    'DFS=$(fsid "$ddir")',
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
