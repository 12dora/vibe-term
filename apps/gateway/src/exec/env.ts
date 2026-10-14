import { userInfo } from 'node:os';
import { applyUtf8LocaleFallback, isVibeTermInjectedEnvKey } from '../tmux/local-shell-path';

export function scrubbedBaseEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isVibeTermInjectedEnvKey(key, false)) out[key] = value;
  }
  return out;
}

/** 旧版 `POST /api/exec` 与 SSH 子进程使用：仅剔除服务内部变量，再叠加调用方 overlay。 */
export function mergedServiceEnv(overlay?: Record<string, string>): Record<string, string> {
  const out = scrubbedBaseEnv();
  if (overlay) Object.assign(out, overlay);
  return out;
}

export type ChannelEnvInput = {
  shell: string;
  path: string | null;
  term: string | null;
  overlay?: Record<string, string>;
};

/** exec 通道本地子进程的环境：剔除服务内部变量，补登录 shell 的 PATH、用户身份与 UTF-8 locale（同 tmux 会话），最后叠加 spec.env。 */
export function buildChannelEnv(input: ChannelEnvInput): Record<string, string> {
  const out = scrubbedBaseEnv();
  if (input.path) out.PATH = input.path;
  out.SHELL = input.shell;
  applyUserIdentity(out);
  applyUtf8LocaleFallback(out);
  if (input.term) out.TERM = input.term;
  if (input.overlay) Object.assign(out, input.overlay);
  return out;
}

function applyUserIdentity(env: Record<string, string>): void {
  try {
    const info = userInfo();
    env.HOME = info.homedir;
    env.USER = info.username;
    env.LOGNAME = info.username;
  } catch {
    // 无 passwd 记录（容器等）时沿用继承值
  }
}
