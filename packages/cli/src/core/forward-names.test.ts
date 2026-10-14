import { describe, expect, test } from 'bun:test';
import {
  EPHEMERAL_NAME_RE,
  computeHostId,
  ephemeralForwardName,
  isReclaimableForward,
  localHostId,
  pidIsDead,
} from './forward-names';

const HOST = '0a1b2c3d';
const errno = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

describe('forward host id and names', () => {
  test('host id is 8 hex chars, stable, and depends on hostname and machine id', () => {
    expect(computeHostId('box', 'abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(computeHostId('box', 'abc')).toBe(computeHostId('box', 'abc'));
    expect(computeHostId('box', 'abc')).not.toBe(computeHostId('other', 'abc'));
    expect(computeHostId('box', 'abc')).not.toBe(computeHostId('box', 'abd'));
    expect(localHostId()).toMatch(/^[0-9a-f]{8}$/);
  });

  test('ephemeral name is fwd:<host8>:<pid36>:<L|R><port>', () => {
    const name = ephemeralForwardName('R', 9000);
    expect(name).toBe(`fwd:${localHostId()}:${process.pid.toString(36)}:R9000`);
    expect(EPHEMERAL_NAME_RE.test(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe('forward stale detection', () => {
  test('EPERM and unknown errors mean alive; only ESRCH means dead', () => {
    expect(pidIsDead(1234, errno('ESRCH'))).toBe(true);
    expect(pidIsDead(1234, errno('EPERM'))).toBe(false);
    expect(pidIsDead(1234, errno('EINVAL'))).toBe(false);
    expect(pidIsDead(1234, () => undefined)).toBe(false);
  });

  test('reclaims only local, foreign-pid names whose process is gone', () => {
    const name = `fwd:${HOST}:${(4242).toString(36)}:L8080`;
    const base = { hostId: HOST, selfPid: 1 };
    expect(isReclaimableForward(name, { ...base, probe: errno('ESRCH') })).toBe(true);
    expect(isReclaimableForward(name, { ...base, probe: errno('EPERM') })).toBe(false);
    expect(isReclaimableForward(name, { ...base, probe: () => undefined })).toBe(false);
    expect(
      isReclaimableForward(name, { hostId: 'ffffffff', selfPid: 1, probe: errno('ESRCH') })
    ).toBe(false);
    expect(isReclaimableForward(name, { hostId: HOST, selfPid: 4242, probe: errno('ESRCH') })).toBe(
      false
    );
  });

  test('never reclaims persistent, legacy or malformed names', () => {
    const options = { hostId: HOST, selfPid: 1, probe: errno('ESRCH') };
    for (const name of ['fwd:L8080', 'fwd:zzzzzz:L8080', 'web', `fwd:${HOST}:xyz:Q1`, '']) {
      expect(isReclaimableForward(name, options)).toBe(false);
    }
  });
});
