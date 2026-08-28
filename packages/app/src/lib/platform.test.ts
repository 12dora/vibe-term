import { describe, expect, test } from 'bun:test';
import { detectServiceManager } from './platform';

function probeWith(results: Record<string, number | null>) {
  const calls: string[] = [];
  const probe = async (_cmd: string, args: string[]) => {
    const key = args.join(' ');
    calls.push(key);
    const code = results[key];
    return code === null || code === undefined ? null : { code };
  };
  return { probe, calls };
}

describe('detectServiceManager', () => {
  test('darwin → launchd without probing', async () => {
    const { probe, calls } = probeWith({});
    expect(await detectServiceManager('darwin', probe)).toBe('launchd');
    expect(calls).toEqual([]);
  });

  test('linux with reachable user manager → systemd-user', async () => {
    const { probe } = probeWith({ '--version': 0, '--user show-environment': 0 });
    expect(await detectServiceManager('linux', probe)).toBe('systemd-user');
  });

  test('linux: systemctl present but user manager unreachable → none', async () => {
    const { probe, calls } = probeWith({ '--version': 0, '--user show-environment': 1 });
    expect(await detectServiceManager('linux', probe)).toBe('none');
    expect(calls).toEqual(['--version', '--user show-environment']);
  });

  test('linux without systemctl → none', async () => {
    const { probe, calls } = probeWith({ '--version': null });
    expect(await detectServiceManager('linux', probe)).toBe('none');
    expect(calls).toEqual(['--version']);
  });

  test('other platforms → none', async () => {
    const { probe } = probeWith({});
    expect(await detectServiceManager('win32', probe)).toBe('none');
  });
});
