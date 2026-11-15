import { describe, expect, test } from 'bun:test';

import { LocalTmuxServerLiveness, classifyProcState, parseProcState } from './tmux-server-liveness';

const stat = (state: string) => `4242 (tmux: server (x)) ${state} 1 4242 4242 0 -1`;

async function learned(liveness: LocalTmuxServerLiveness): Promise<void> {
  liveness.prepare();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('tmux server liveness', () => {
  test('parses the state after the last parenthesis of comm', () => {
    expect(parseProcState(stat('S'))).toBe('S');
    expect(parseProcState('garbage')).toBeNull();
    expect(parseProcState(null)).toBeNull();
  });

  test('running / sleeping / disk wait are alive; stopped, zombie or missing are dead', () => {
    for (const state of ['R', 'S', 'D', 'I']) expect(classifyProcState(state)).toBe('alive');
    for (const state of ['T', 't', 'Z', 'X']) expect(classifyProcState(state)).toBe('dead');
    expect(classifyProcState(null)).toBe('dead');
  });

  test('learns the server pid once on prepare and reads /proc through the injected reader', async () => {
    let queries = 0;
    const reads: number[] = [];
    let state = 'D';
    const liveness = new LocalTmuxServerLiveness(
      'linux',
      async () => {
        queries += 1;
        return '4242\n';
      },
      (pid) => {
        reads.push(pid);
        return state === '' ? null : stat(state);
      }
    );
    expect(liveness.check()).toBe('unknown');
    await learned(liveness);
    await learned(liveness);
    expect(queries).toBe(1);
    expect(liveness.serverPid).toBe(4242);
    expect(liveness.check()).toBe('alive');
    state = 'T';
    expect(liveness.check()).toBe('dead');
    expect(liveness.serverPid).toBeNull();
    expect(reads).toEqual([4242, 4242]);
  });

  test('non-Linux hosts skip the check', async () => {
    let queries = 0;
    const liveness = new LocalTmuxServerLiveness('darwin', async () => {
      queries += 1;
      return '1';
    });
    await learned(liveness);
    expect(queries).toBe(0);
    expect(liveness.check()).toBe('unknown');
  });

  test('a failed pid query leaves the probe unknown', async () => {
    const liveness = new LocalTmuxServerLiveness('linux', async () => {
      throw new Error('spawn failed');
    });
    await learned(liveness);
    expect(liveness.check()).toBe('unknown');
  });
});
