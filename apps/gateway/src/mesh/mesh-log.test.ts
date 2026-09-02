import { describe, expect, test } from 'bun:test';
import { envInt, formatLogLine, isoNow, stamp } from './mesh-log';

describe('mesh-log', () => {
  test('isoNow and formatLogLine prefix ISO-8601 milliseconds UTC', () => {
    const at = new Date('2026-09-02T07:00:00.123Z');
    expect(isoNow(at)).toBe('2026-09-02T07:00:00.123Z');
    expect(formatLogLine('[mesh][stream]', 'failover stream=abc', at)).toBe(
      '2026-09-02T07:00:00.123Z [mesh][stream] failover stream=abc'
    );
  });

  test('stamp prefixes lines that lack a timestamp and leaves stamped lines unchanged', () => {
    const stamped = stamp('[uplink] candidate failed hub=x err=y fails=1');
    expect(stamped).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[uplink\] candidate failed hub=x err=y fails=1$/
    );
    expect(stamp(stamped)).toBe(stamped);
  });

  test('envInt reads a finite integer with a floor, else the fallback', () => {
    const key = 'TMEX_MESH_LOG_ENVINT_TEST';
    const prev = process.env[key];
    try {
      delete process.env[key];
      expect(envInt(key, 250)).toBe(250);
      process.env[key] = ' 80 ';
      expect(envInt(key, 250)).toBe(80);
      process.env[key] = '-1';
      expect(envInt(key, 250, 0)).toBe(250);
      process.env[key] = 'nope';
      expect(envInt(key, 250)).toBe(250);
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});
