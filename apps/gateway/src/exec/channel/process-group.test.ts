import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { EXEC_KILL_GRACE_MS } from '../constants';
import { GroupControl } from './process-group';

type KillCall = { pid: number; sig: string | number | undefined };

const realKill = process.kill.bind(process);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let kills: KillCall[] = [];
let timers: { fn: () => void; ms: number | undefined; cleared: boolean }[] = [];

function installSpies(): void {
  kills = [];
  timers = [];
  process.kill = ((pid: number, sig?: string | number) => {
    if (sig === 0) return realKill(pid, 0);
    kills.push({ pid, sig });
    return true;
  }) as typeof process.kill;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const entry = { fn, ms, cleared: false };
    timers.push(entry);
    return {
      unref() {},
      [Symbol.toPrimitive]: () => timers.length,
      entry,
    };
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: { entry?: { cleared: boolean } }) => {
    if (handle?.entry) handle.entry.cleared = true;
  }) as unknown as typeof clearTimeout;
}

function restoreSpies(): void {
  process.kill = realKill;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

let reaped = 0;

beforeAll(async () => {
  const child = Bun.spawn(['/bin/true'], { detached: true });
  await child.exited;
  reaped = child.pid;
});

const sent = (sig: string) => kills.filter((k) => k.sig === sig);
const graceTimers = () => timers.filter((t) => t.ms === EXEC_KILL_GRACE_MS);

describe('GroupControl', () => {
  beforeEach(installSpies);
  afterEach(restoreSpies);

  test('kill after the leader was reaped sends nothing and arms no SIGKILL timer', () => {
    const pid = reaped;
    const control = new GroupControl(pid, () => true);
    control.kill();
    expect(kills).toEqual([]);
    expect(graceTimers()).toEqual([]);
  });

  test('kill on a live group sends SIGCONT then SIGTERM and arms the SIGKILL timer', () => {
    const control = new GroupControl(process.pid, () => false);
    control.kill();
    expect(kills.map((k) => k.sig)).toEqual(['SIGCONT', 'SIGTERM']);
    expect(kills[0]?.pid).toBe(-process.pid);
    expect(graceTimers()).toHaveLength(1);
    control.kill();
    expect(graceTimers()).toHaveLength(1);
  });

  test('the SIGKILL timer does nothing once the leader is reaped and the group is gone', () => {
    const pid = reaped;
    let exited = false;
    const control = new GroupControl(pid, () => exited);
    control.kill();
    const timer = graceTimers()[0];
    expect(timer).toBeDefined();
    kills = [];
    exited = true;
    timer?.fn();
    expect(sent('SIGKILL')).toEqual([]);
  });

  test('settle cancels a pending SIGKILL timer when the group is gone after exit', () => {
    const pid = reaped;
    let exited = false;
    const control = new GroupControl(pid, () => exited);
    control.kill();
    exited = true;
    control.settle();
    expect(graceTimers()[0]?.cleared).toBe(true);
  });

  test('the SIGKILL timer still fires while the group has live members', () => {
    const control = new GroupControl(process.pid, () => false);
    control.kill();
    kills = [];
    graceTimers()[0]?.fn();
    expect(sent('SIGKILL')).toHaveLength(1);
  });

  test('stop is skipped after the leader exited', () => {
    const control = new GroupControl(process.pid, () => true);
    control.stop();
    expect(sent('SIGSTOP')).toEqual([]);
  });

  test('stop and resume signal the leader group while it is alive', () => {
    const control = new GroupControl(process.pid, () => false);
    control.stop();
    control.resume();
    expect(sent('SIGSTOP').map((k) => k.pid)).toContain(-process.pid);
    expect(sent('SIGCONT').map((k) => k.pid)).toContain(-process.pid);
  });

  test('resume is skipped once the leader is reaped and the group is gone', () => {
    const pid = reaped;
    new GroupControl(pid, () => true).resume();
    expect(kills).toEqual([]);
  });
});
