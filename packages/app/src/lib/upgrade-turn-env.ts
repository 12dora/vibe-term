import { t } from '../i18n';
import { readEnvFile } from './env-file';
import { pathExists } from './fs-utils';
import { createInstallLayout } from './install-layout';

export function hasExternalTurnTriple(env: Record<string, string>): boolean {
  return Boolean(
    env.VIBETERM_TURN_URL?.trim() &&
      env.VIBETERM_TURN_USERNAME?.trim() &&
      env.VIBETERM_TURN_CREDENTIAL?.trim()
  );
}

/** 升级时不删除遗留 TURN 三元组；仅在仍配置外部 TURN 时打一行提示。 */
export async function applyTurnEnvNotice(
  installDir: string,
  log: (message: string) => void
): Promise<boolean> {
  const envPath = createInstallLayout(installDir).envPath;
  if (!(await pathExists(envPath))) return false;
  const values = await readEnvFile(envPath);
  if (!hasExternalTurnTriple(values)) return false;
  log(t('upgrade.turnExternalNotice'));
  return true;
}
