import type { Device, FileErrorCode } from '@vibeterm/shared';
import { quoteShellArg } from '../tmux-client/command-builder';
import {
  type DeleteOutcome,
  type DeleteStatus,
  type DeleteTarget,
  posixBasename,
  posixDirname,
} from './delete-local';
import { execSshCommand } from './directory-browse';
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

export const fileDeleteIo = {
  execSsh: execSshCommand,
};

function buildItemScript(item: DeleteTarget): string {
  const parent = quoteShellArg(posixDirname(item.path));
  const entry = quoteShellArg(`./${posixBasename(item.path)}`);
  const say = (status: string) => `echo "${OP_MARKER} ${item.index} ${status}"`;
  return [
    '(',
    `cd -- ${parent} 2>/dev/null || { ${say('not_found')}; exit; };`,
    'd=$(pwd -P);',
    `case "$d/" in "$p"*) ;; *) ${say('outside_roots')}; exit;; esac;`,
    `if [ ! -e ${entry} ] && [ ! -L ${entry} ]; then ${say('not_found')}; exit; fi;`,
    `rm -rf -- ${entry} 2>/dev/null && ${say('ok')} || ${say('permission_denied')}`,
    ')',
  ].join(' ');
}

/**
 * 一次 ssh 往返处理整批：先取真实 root，每项在子 shell 里 `cd` 到父目录核对 realpath 仍在
 * root 内，末段以 `./name` 寻址且从不解引用（`rm -rf` 对符号链接只删链接本身）。
 */
export function buildDeleteCommand(rootPath: string, items: readonly DeleteTarget[]): string {
  return [
    `r=$(cd -- ${quoteShellArg(rootPath)} 2>/dev/null && pwd -P) || exit ${ROOT_MISSING_EXIT}`,
    'p="$r/"; [ "$r" = / ] && p=/',
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
    const res = await fileDeleteIo.execSsh(
      spec,
      buildDeleteCommand(rootPath, targets),
      DELETE_TIMEOUT_MS
    );
    if (res.exitCode !== 0) return classifyDeleteSsh(res.exitCode, res.stderr);
    return ok(parseDeleteOutput(res.stdout));
  });
}
