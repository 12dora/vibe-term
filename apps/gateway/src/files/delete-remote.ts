import type { Device, FileErrorCode } from '@vibeterm/shared';
import { quoteShellArg } from '../tmux-client/command-builder';
import {
  type DeleteOutcome,
  type DeleteStatus,
  type DeleteTarget,
  posixBasename,
  posixDirname,
} from './delete-local';
import { SH_INSIDE_FN, SH_PHYS_FN, execRemoteScript } from './remote-script';
import { type FileOpResult, fail, ok, withDeviceRsync } from './rsync-operation';

const OP_MARKER = 'VTOP';
const ROOT_MISSING_EXIT = 60;
const DELETE_TIMEOUT_MS = 60_000;

const REMOTE_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'not_found',
  'outside_roots',
  'permission_denied',
]);

function buildItemScript(item: DeleteTarget): string {
  const parent = quoteShellArg(posixDirname(item.path));
  const entry = quoteShellArg(`./${posixBasename(item.path)}`);
  const say = (status: string) => `echo "${OP_MARKER} ${item.index} ${status}"`;
  return [
    '(',
    `cd -- ${parent} 2>/dev/null || { ${say('not_found')}; exit; };`,
    `phys || { ${say('not_found')}; exit; };`,
    `inside "$PHYS" "$r" || { ${say('outside_roots')}; exit; };`,
    `if [ ! -e ${entry} ] && [ ! -L ${entry} ]; then ${say('not_found')}; exit; fi;`,
    `rm -rf -- ${entry} 2>/dev/null && ${say('ok')} || ${say('permission_denied')}`,
    ')',
  ].join(' ');
}

/**
 * 整批脚本（经 stdin 交给 `sh -s`）：先取真实 root（`phys` 保留结尾换行），每项在子 shell 里
 * `cd` 到父目录，核对其物理路径仍在 root 内；末段以 `./name` 寻址且从不解引用
 * （`rm -rf` 对符号链接只删链接本身）。
 */
export function buildDeleteCommand(rootPath: string, items: readonly DeleteTarget[]): string {
  return [
    SH_PHYS_FN,
    SH_INSIDE_FN,
    `cd -- ${quoteShellArg(rootPath)} 2>/dev/null || exit ${ROOT_MISSING_EXIT}`,
    `phys || exit ${ROOT_MISSING_EXIT}`,
    'r=$PHYS',
    ...items.map(buildItemScript),
    'exit 0',
  ].join('\n');
}

export function parseDeleteOutput(stdout: Uint8Array): DeleteOutcome {
  const outcome: DeleteOutcome = new Map();
  for (const line of new TextDecoder().decode(stdout).split('\n')) {
    const match = /^VTOP (\d+) (\w+)\s*$/.exec(line);
    if (!match) continue;
    const status = match[2] ?? '';
    const known = REMOTE_STATUSES.has(status);
    outcome.set(Number(match[1]), known ? (status as DeleteStatus) : 'unknown');
  }
  return outcome;
}

function classifyDeleteSsh(exitCode: number, stderr: string): ReturnType<typeof fail> {
  let code: FileErrorCode = 'unknown';
  if (exitCode === ROOT_MISSING_EXIT) code = 'root_not_found';
  else if (exitCode === 124) code = 'timeout';
  else if (exitCode === 255) code = 'connection_failed';
  return fail(code, stderr);
}

export function deleteRemoteTargets(
  device: Device,
  rootPath: string,
  targets: readonly DeleteTarget[]
): Promise<FileOpResult<DeleteOutcome>> {
  return withDeviceRsync(device, async (spec) => {
    const res = await execRemoteScript(
      spec,
      buildDeleteCommand(rootPath, targets),
      DELETE_TIMEOUT_MS
    );
    if (res.exitCode !== 0) return classifyDeleteSsh(res.exitCode, res.stderr);
    return ok(parseDeleteOutput(res.stdout));
  });
}
