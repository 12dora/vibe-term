import { describe, expect, test } from 'bun:test';
import {
  WS_DIAL_RACE_DEFAULT,
  WS_DIAL_RACE_MAX,
  WS_DIAL_RACE_MIN,
  clampWsDialRace,
  parseWsDialRace,
  wsDialRaceCount,
} from './ws-dial-race-config';

describe('ws dial race config', () => {
  test('missing or unparsable values fall back to the default', () => {
    expect(parseWsDialRace(undefined)).toBe(WS_DIAL_RACE_DEFAULT);
    expect(parseWsDialRace(null)).toBe(WS_DIAL_RACE_DEFAULT);
    expect(parseWsDialRace('')).toBe(WS_DIAL_RACE_DEFAULT);
    expect(parseWsDialRace('   ')).toBe(WS_DIAL_RACE_DEFAULT);
    expect(parseWsDialRace('abc')).toBe(WS_DIAL_RACE_DEFAULT);
  });

  test('clamps to 1..4', () => {
    expect(parseWsDialRace('0')).toBe(WS_DIAL_RACE_MIN);
    expect(parseWsDialRace('-3')).toBe(WS_DIAL_RACE_MIN);
    expect(parseWsDialRace('1')).toBe(1);
    expect(parseWsDialRace('3')).toBe(3);
    expect(parseWsDialRace('4')).toBe(4);
    expect(parseWsDialRace('9')).toBe(WS_DIAL_RACE_MAX);
    expect(parseWsDialRace(' 2 ')).toBe(2);
    expect(parseWsDialRace('2.9')).toBe(2);
  });

  test('clampWsDialRace mirrors the parser bounds', () => {
    expect(clampWsDialRace(0)).toBe(1);
    expect(clampWsDialRace(2)).toBe(2);
    expect(clampWsDialRace(99)).toBe(4);
    expect(clampWsDialRace(Number.NaN)).toBe(WS_DIAL_RACE_DEFAULT);
  });

  test('the process-wide value is read once and stays in range', () => {
    const count = wsDialRaceCount();
    expect(count).toBe(wsDialRaceCount());
    expect(count).toBeGreaterThanOrEqual(WS_DIAL_RACE_MIN);
    expect(count).toBeLessThanOrEqual(WS_DIAL_RACE_MAX);
    expect(count).toBe(parseWsDialRace(process.env.VIBETERM_WS_DIAL_RACE));
  });
});
