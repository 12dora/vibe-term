// run.sh 的事务级备份：回滚到旧版本时必须原样还原旧 run.sh（旧 runtime 只认 TMEX_* 路径变量，
// 新模板不再镜像旧前缀），不能用新模板重写。备份放在 backups/<txn>/ 下，随事务清理。
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, pathExists } from './fs-utils';
import { writeRunScript } from './install';
import { createInstallLayout } from './install-layout';

export function runScriptBackupPath(installDir: string, txnId: string): string {
  return join(installDir, 'backups', txnId, 'run.sh');
}

/** 已有备份不覆盖：旧布局转换会先重写 run.sh，第一份（真正的旧脚本）才是要还原的那份。 */
export async function backupRunScript(installDir: string, txnId: string): Promise<boolean> {
  const source = createInstallLayout(installDir).runScriptPath;
  if (!(await pathExists(source))) return false;
  const target = runScriptBackupPath(installDir, txnId);
  if (await pathExists(target)) return true;
  await ensureDir(join(installDir, 'backups', txnId));
  await copyFile(source, target);
  return true;
}

export async function restoreRunScript(
  installDir: string,
  txnId: string,
  bunPath: string
): Promise<'restored' | 'rewritten'> {
  const layout = createInstallLayout(installDir);
  const backup = runScriptBackupPath(installDir, txnId);
  if (await pathExists(backup)) {
    await copyFile(backup, layout.runScriptPath);
    return 'restored';
  }
  await writeRunScript(layout, bunPath);
  return 'rewritten';
}
