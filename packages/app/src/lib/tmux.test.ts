import { describe, expect, test } from 'bun:test';
import { checkTmuxVersion } from './tmux';

describe('checkTmuxVersion', () => {
  test('returns ok on a system with tmux installed', async () => {
    const result = await checkTmuxVersion();
    expect(result.ok).toBe(true);
    expect(result.versionRaw).toBeTruthy();
  });

  test('returns version-too-low with unrealistically high min', async () => {
    const result = await checkTmuxVersion({ major: 999, minor: 0 });
    if (result.ok) {
      // tmux might have unparseable version (master), which passes
      expect(result.version).toBeUndefined();
    } else {
      expect(result.reason).toBe('version-too-low');
    }
  });
});
