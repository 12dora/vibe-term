import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupRunScript, restoreRunScript, runScriptBackupPath } from './upgrade-run-script';

async function makeInstallDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'vibeterm-runscript-'));
}

describe('run.sh 事务备份', () => {
  it('回滚时原样还原备份的旧 run.sh，而不是用新模板重写', async () => {
    const dir = await makeInstallDir();
    const legacy = '#!/usr/bin/env bash\nexport TMEX_FE_DIST_DIR=/old\nexec bun server.js\n';
    await writeFile(join(dir, 'run.sh'), legacy, { mode: 0o755 });
    expect(await backupRunScript(dir, 'txn1')).toBe(true);
    expect(await readFile(runScriptBackupPath(dir, 'txn1'), 'utf8')).toBe(legacy);

    await writeFile(join(dir, 'run.sh'), '#!/usr/bin/env bash\nexport VIBETERM_FE_DIST_DIR=/new\n');
    expect(await restoreRunScript(dir, 'txn1', '/usr/bin/bun')).toBe('restored');
    expect(await readFile(join(dir, 'run.sh'), 'utf8')).toBe(legacy);
  });

  it('没有备份时退回新模板重写', async () => {
    const dir = await makeInstallDir();
    expect(await backupRunScript(dir, 'txn2')).toBe(false);
    expect(await restoreRunScript(dir, 'txn2', '/usr/bin/bun')).toBe('rewritten');
    expect(await readFile(join(dir, 'run.sh'), 'utf8')).toContain('VIBETERM_INSTALL_DIR');
  });
});
