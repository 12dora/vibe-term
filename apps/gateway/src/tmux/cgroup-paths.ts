import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_PROTECTED_SLICE = 'session.slice';
export const DEFAULT_WORKLOAD_SLICE = 'app.slice';

const TMUX_SPAWN_SCOPE = /^tmux-spawn-[A-Za-z0-9_-]+\.scope$/;
const SLICE_NAME = /^[A-Za-z0-9:_.-]+\.slice$/;

export function isValidSliceName(value: string): boolean {
  return SLICE_NAME.test(value) && !value.includes('/');
}

export function isTmuxSpawnScope(unit: string): boolean {
  return TMUX_SPAWN_SCOPE.test(unit);
}

/** cgroup v2 统一层级行 `0::/path`；没有时返回 null。 */
export function parseProcCgroup(text: string | null): string | null {
  if (!text) return null;
  for (const line of text.split('\n')) {
    if (line.startsWith('0::')) {
      const path = line.slice(3).trim();
      return path.startsWith('/') ? path : null;
    }
  }
  return null;
}

/** 截出 `/user.slice/user-<uid>.slice/user@<uid>.service`，不在当前 uid 的用户管理器下返回 null。 */
export function parseUserRoot(cgroup: string, uid: number): string | null {
  const match = /^(\/user\.slice\/user-(\d+)\.slice\/user@(\d+)\.service)(?:\/|$)/.exec(cgroup);
  if (!match) return null;
  if (match[2] !== String(uid) || match[3] !== String(uid)) return null;
  return match[1] ?? null;
}

export function unitOf(cgroup: string): string {
  const trimmed = cgroup.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function isUnderRoot(cgroup: string, root: string): boolean {
  return cgroup.startsWith(`${root}/`);
}

/** 用户管理器下的路径是否落在 slice（含其嵌套子 slice）里。 */
export function isInsideSlice(cgroup: string, root: string, slice: string): boolean {
  if (!isUnderRoot(cgroup, root)) return false;
  return cgroup
    .slice(root.length + 1)
    .split('/')
    .includes(slice);
}

function statusField(text: string | null, field: string): number | null {
  if (!text) return null;
  const line = text.split('\n').find((row) => row.startsWith(`${field}:`));
  const raw =
    line
      ?.slice(field.length + 1)
      .trim()
      .split(/\s+/)[0] ?? '';
  if (!/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

export function parseStatusUid(text: string | null): number | null {
  return statusField(text, 'Uid');
}

export function parseStatusPpid(text: string | null): number | null {
  return statusField(text, 'PPid');
}

export function parsePidList(text: string | null): number[] {
  if (!text) return [];
  const pids: number[] = [];
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!/^\d+$/.test(raw)) continue;
    const pid = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

export function serverScopeName(socketPath: string): string {
  const hash = createHash('sha256').update(socketPath).digest('hex').slice(0, 12);
  return `vibeterm-tmux-${hash}.scope`;
}

export function paneScopeName(uuid: string = randomUUID()): string {
  return `vibeterm-pane-${uuid}.scope`;
}

export function cgroupProcsPath(cgroup: string, cgroupFs = '/sys/fs/cgroup'): string {
  return `${cgroupFs}${cgroup}/cgroup.procs`;
}
