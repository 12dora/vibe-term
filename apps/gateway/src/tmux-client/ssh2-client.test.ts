import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 全量 bun test 共享模块注册表，其它用例可能早已 loadSsh2()，所以不能靠运行期标志判断；
// 只锁「连接模块自身没有静态 import ssh2」这一事实。
describe('ssh2 lazy load', () => {
  test('SSH connection module only imports ssh2 as a type', () => {
    const source = readFileSync(resolve(import.meta.dir, 'ssh-external-connection.ts'), 'utf8');
    const valueImports = source
      .split('\n')
      .filter((line) => /from\s+'ssh2'/.test(line) && !/^\s*import\s+type\b/.test(line));
    expect(valueImports).toEqual([]);
    expect(source).toContain("from './ssh2-client'");
  });
});
