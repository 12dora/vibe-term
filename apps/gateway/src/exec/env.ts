import { userInfo } from 'node:os';

const SCRUBBED_ENV_KEY = /^(VIBETERM_|TMEX_)|^(DATABASE_URL|NODE_ENV)$/;

export function scrubbedBaseEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !SCRUBBED_ENV_KEY.test(key)) out[key] = value;
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

/** exec 通道本地子进程的环境：剔除服务内部变量，补登录 shell 的 PATH 与用户身份，最后叠加 spec.env。 */
export function buildChannelEnv(input: ChannelEnvInput): Record<string, string> {
  const out = scrubbedBaseEnv();
  if (input.path) out.PATH = input.path;
  out.SHELL = input.shell;
  applyUserIdentity(out);
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
