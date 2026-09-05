import { readFile } from 'node:fs/promises';
import { runCommand } from '../lib/process';
import {
  SYSTEMD_KILL_MODE_WARNING,
  systemdUnitLacksKillModeProcess,
  tmexSystemdUnitPath,
} from '../lib/service';
import {
  SYSTEMD_OOM_POLICY_WARNING,
  parseDefaultOomPolicy,
  shouldWarnAboutOomPolicy,
} from '../lib/systemd-oom-policy';

async function readUnit(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** 只读自检：装过旧版 unit 的机器（1.1.x 之前）重启服务会连 tmux 一起杀，启动时必须喊一声。 */
export async function warnOnStaleSystemdUnit(
  deps: {
    platform?: NodeJS.Platform;
    unitPath?: string;
    readUnit?: (path: string) => Promise<string | null>;
    warn?: (line: string) => void;
  } = {}
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return false;
  const content = await (deps.readUnit ?? readUnit)(deps.unitPath ?? tmexSystemdUnitPath());
  if (!systemdUnitLacksKillModeProcess(content)) return false;
  (deps.warn ?? console.warn)(SYSTEMD_KILL_MODE_WARNING);
  return true;
}

const PROBE_TIMEOUT_MS = 3_000;

async function probe(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await runCommand(command, args, { timeoutMs: PROBE_TIMEOUT_MS });
    if (result.code !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

/**
 * 只读自检：tmux ≥ 3.6 的 pane 各占一个 systemd scope，`DefaultOOMPolicy=stop` 会让一次内核
 * OOM 击杀带走整个窗口。1.1.34 起托管安装会自动写 drop-in，这里覆盖手动部署 / 升级前的机器。
 */
export async function warnOnSystemdOomPolicy(
  deps: {
    platform?: NodeJS.Platform;
    probe?: (command: string, args: string[]) => Promise<string | null>;
    warn?: (line: string) => void;
  } = {}
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return false;
  const run = deps.probe ?? probe;
  const policy = parseDefaultOomPolicy(
    await run('systemctl', ['--user', 'show', '-p', 'DefaultOOMPolicy'])
  );
  if (policy !== 'stop') return false;
  const tmuxVersion = await run('tmux', ['-V']);
  if (!shouldWarnAboutOomPolicy(policy, tmuxVersion)) return false;
  (deps.warn ?? console.warn)(SYSTEMD_OOM_POLICY_WARNING);
  return true;
}
