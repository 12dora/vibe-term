import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createInstallLayout } from './install-layout';

describe('createInstallLayout', () => {
  test('nativeDir is <installDir>/native', () => {
    const layout = createInstallLayout('/tmp/tmex-install-test');
    expect(layout.nativeDir).toBe(join('/tmp/tmex-install-test', 'native'));
    expect(layout.runtimeDir).toBe(join('/tmp/tmex-install-test', 'runtime'));
    expect(layout.runtimeCliAuthPath).toBe(
      join('/tmp/tmex-install-test', 'runtime', 'cli-auth.js')
    );
    expect(layout.runtimeServerPath).toBe(join('/tmp/tmex-install-test', 'runtime', 'server.js'));
    expect(layout.envPath).toBe(join('/tmp/tmex-install-test', 'app.env'));
  });
});
