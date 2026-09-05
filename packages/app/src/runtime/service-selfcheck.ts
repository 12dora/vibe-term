import { readFile } from 'node:fs/promises';
import {
  SYSTEMD_KILL_MODE_WARNING,
  systemdUnitLacksKillModeProcess,
  tmexSystemdUnitPath,
} from '../lib/service';

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
