import {
  MIN_TMUX_VERSION,
  type TmuxVersion,
  compareTmuxVersion,
  parseTmuxVersion,
} from '../../../shared/src/tmux-version';
import { runCommand } from './process';

export type { TmuxVersion };
export { compareTmuxVersion, parseTmuxVersion };

export interface TmuxCheckResult {
  ok: boolean;
  path?: string;
  version?: TmuxVersion;
  versionRaw?: string;
  reason?: 'not-found' | 'version-too-low';
}

export async function checkTmuxVersion(
  minVersion: TmuxVersion = MIN_TMUX_VERSION
): Promise<TmuxCheckResult> {
  const result = await runCommand('tmux', ['-V'], {
    stdio: 'pipe',
    timeoutMs: 5000,
  }).catch(() => null);

  if (!result || result.code !== 0) {
    return { ok: false, reason: 'not-found' };
  }

  const raw = result.stdout.trim();
  const version = parseTmuxVersion(raw);

  if (!compareTmuxVersion(version, minVersion)) {
    return {
      ok: false,
      version: version ?? undefined,
      versionRaw: raw,
      reason: 'version-too-low',
    };
  }

  return {
    ok: true,
    version: version ?? undefined,
    versionRaw: raw,
  };
}
