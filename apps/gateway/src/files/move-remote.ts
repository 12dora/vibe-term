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
// 脚本开头固定 `LC_ALL=C`：stderr 文案只用来给「失败原因」分类（permission_denied / unknown），
// 不能受远端 locale 影响；任何破坏性动作都不依赖文案。
//
// 设计原则：绝不让 mv 复制数据（它跨设备时的隐式「复制 + 删除」在 GNU / BusyBox / BSD / macOS 上顺序与
// 报错各不相同，无法控制）；绝不凭错误文案删除任何东西；源只在目标目录项已经提交之后才删除。
// - 普通文件：先在目标目录内取得私有项 `.vtmv.<pid>.<index>`（`ln` 硬链接，原子且不复制；跨挂载点或
//   不支持硬链接时退回显式 `cp -p`，失败只清理这份自己的半成品），再用同目录 rename 提交到目标；
//   提交成功后才 `rm` 源。覆盖已有普通文件用 `mv -f` 原子替换；覆盖符号链接 / 其他非目录时先把旧项
//   挪到私有备份 `.bak`，提交失败就挪回，成功才删备份——旧链接永远不会先被删掉。
// - 符号链接和其他非目录：直接 `mv -n`（复制一个符号链接不会丢数据），结果只看文件系统；覆盖同样走备份。
// - 目录：不覆盖。用「在源父目录建空探针文件并 ln 进目标目录」判断能否 rename（不看 df）；能就 `mv -n`，
//   不做任何清理；不能就显式 `cp -Rp` 到目标目录内的私有项，同目录 rename 提交，最后 `rm -rf` 源。
// - 同 inode：要么是上次提交后删源失败的残留（父目录不同，必为两个目录项，补删源），要么是大小写不
//   敏感文件系统上同一个目录项的两个名字（父目录相同，只做普通 rename，绝不 rm）。
// `-T`（GNU 长选项，或 BusyBox help 里只列的短选项）仅作为 `mv -n` 提交上的额外保护，正确性不依赖它。
//
// 残余窗口：没有原子「不覆盖」rename 的平台上，目标在最后一次存在性检查与 mv 之间被别人建出来，
// 仍可能被 `mv -n` 当作容器（目录）收下；shell 在复制 / 提交中途被杀会在目标目录留下 `.vtmv.*`；
// 极少数目录 rename 由 mv 隐式复制（如 overlayfs）失败时，半成品目标会被保留并报 unknown，不清理。
const SCRIPT_FUNCTIONS = [
  SH_PHYS_FN,
  SH_INSIDE_FN,
  'nodir() { [ -L "$1" ] || [ ! -d "$1" ]; }',
  'gone() { [ ! -e "$1" ] && [ ! -L "$1" ]; }',
  // fe：把工具的 stderr 映射成失败原因，只用于状态词
  'fe() { case "$1" in',
  '*ermission*|*not\\ permitted*) echo permission_denied;;',
  '*) echo unknown;;',
  'esac; }',
  // mvn <from> <to>：不覆盖地 mv -n，结果只看文件系统，放进 st：from 消失才算提交
  'mvn() {',
  'e=$(mv -n $T -- "$1" "$2" 2>&1 </dev/null)',
  'if gone "$1"; then',
  'if gone "$2"; then st=unknown; return 1; fi',
  'st=ok; return 0',
  'fi',
  'if ! gone "$2"; then st=already_exists; return 1; fi',
  'st=$(fe "$e"); return 1',
  '}',
  // cmt：提交前最后确认一次目标仍不存在（收窄窗口），再 mvn
  'cmt() { if ! gone "$2"; then st=already_exists; return 1; fi; mvn "$1" "$2"; }',
  // rms：提交之后删源；删不掉时数据同时存在于两处，目标不回滚
  'rms() {',
  'rm -f -- "$s" 2>/dev/null </dev/null',
  'if gone "$s"; then st=ok; else st=permission_denied; fi',
  '}',
  // mkp：在目标目录内取得指向源数据的私有项 tp，不碰源；先硬链接，不行再显式复制
  'mkp() {',
  'gone "$tp" || { st=unknown; return 1; }',
  'ln -- "$s" "$tp" 2>/dev/null </dev/null && return 0',
  'if e=$(cp -p -- "$s" "$tp" 2>&1 </dev/null); then return 0; fi',
  'rm -f -- "$tp" 2>/dev/null </dev/null',
  'st=$(fe "$e"); return 1',
  '}',
  // asd <from>：覆盖符号链接 / 其他非目录。旧项先挪到私有备份 bk，提交失败就挪回，成功才删备份
  'asd() {',
  'gone "$bk" || { st=unknown; return 1; }',
  'e=$(mv -f -- "$dp" "$bk" 2>&1 </dev/null)',
  'if gone "$bk"; then st=$(fe "$e"); return 1; fi',
  'if cmt "$1" "$dp"; then rm -f -- "$bk" 2>/dev/null </dev/null; return 0; fi',
  '_s=$st',
  'mv -n $T -- "$bk" "$dp" 2>/dev/null </dev/null',
  'if gone "$bk"; then st=$_s; elif [ "$_s" != already_exists ]; then st=unknown; fi',
  'return 1',
  '}',
  // putf <n|o>：普通文件
  'putf() {',
  'mkp || return 1',
  'if [ "$1" = n ]; then',
  'cmt "$tp" "$dp" || { rm -f -- "$tp" 2>/dev/null </dev/null; return 1; }',
  'elif [ -f "$dp" ] && [ ! -L "$dp" ]; then',
  'if ! e=$(mv -f -- "$tp" "$dp" 2>&1 </dev/null); then',
  'rm -f -- "$tp" 2>/dev/null </dev/null; st=$(fe "$e"); return 1',
  'fi',
  'rm -f -- "$tp" 2>/dev/null </dev/null',
  'else',
  'asd "$tp" || { rm -f -- "$tp" 2>/dev/null </dev/null; return 1; }',
  'fi',
  'rms',
  '}',
  // putl <n|o>：符号链接和其他非目录，源本身直接提交
  'putl() { if [ "$1" = o ]; then asd "$s"; else cmt "$s" "$dp"; fi; }',
  // putd：目录（只会以 n 调用）。探针决定能否 rename，不能就显式复制再提交
  'putd() {',
  'pf="./.vtmv.$$.$i.p"; pl="${ddir%/}/.vtmv.$$.$i.q"',
  'gone "$pf" && gone "$pl" || { st=unknown; return 1; }',
  '( set -C; : >"$pf" ) 2>/dev/null </dev/null || { st=permission_denied; return 1; }',
  'lk=0',
  'ln -- "$pf" "$pl" 2>/dev/null </dev/null && lk=1',
  'rm -f -- "$pf" "$pl" 2>/dev/null </dev/null',
  'if [ "$lk" = 1 ]; then cmt "$s" "$dp"; return; fi',
  'gone "$tp" || { st=unknown; return 1; }',
  'if ! e=$(cp -Rp -- "$s" "$tp" 2>&1 </dev/null); then',
  'rm -rf -- "$tp" 2>/dev/null </dev/null; st=$(fe "$e"); return 1',
  'fi',
  'cmt "$tp" "$dp" || { rm -rf -- "$tp" 2>/dev/null </dev/null; return 1; }',
  'rm -rf -- "$s" 2>/dev/null </dev/null',
  'if gone "$s"; then st=ok; else st=permission_denied; fi',
  '}',
  // same：源与目标是同一 inode（符号链接不参与）。返回 0 表示已处理，状态在 st
  'same() {',
  'if [ -L "$s" ] || [ -L "$dp" ] || [ ! -e "$dp" ]; then return 1; fi',
  'if ! [ "$s" -ef "$dp" ]; then return 1; fi',
  'if [ "$pr" = "$ddir" ]; then',
  'mv -f -- "$s" "$dp" 2>/dev/null </dev/null',
  'if gone "$dp"; then st=unknown; else st=ok; fi',
  'return 0',
  'fi',
  '[ -f "$s" ] || return 1',
  'rms',
  'return 0',
  '}',
  // put <n|o>：按源类型分派
  'put() {',
  'if [ -d "$s" ] && [ ! -L "$s" ]; then putd',
  'elif [ -f "$s" ] && [ ! -L "$s" ]; then putf "$1"',
  'else putl "$1"; fi',
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
  'bk="$tp.bak"',
  'if [ -d "$s" ] && [ ! -L "$s" ]; then',
  'case "${ddir%/}/" in "${pr%/}/$n"/*) echo "VTOP $i invalid"; return 0;; esac',
  'fi',
  'st=unknown',
  'if same; then :',
  'elif gone "$dp"; then put n',
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
