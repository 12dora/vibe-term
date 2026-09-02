import { describe, expect, test } from 'bun:test';
import {
  RTC_DIAL_FAILED_LOG_INTERVAL_MS,
  RTC_LOG_PREFIX,
  createIceCandidateTrace,
  formatRtcLog,
  iceTypesOf,
  noteCandidate,
  resetRtcLogStateForTest,
  rtcLog,
  rtcLogRateLimited,
} from './rtc-log';

describe('rtc-log', () => {
  test('formats structured fields and candidate type sets', () => {
    expect(
      formatRtcLog('dial start', {
        peer: 'aa',
        role: 'offerer',
        stun_count: 2,
        turn_enabled: false,
      })
    ).toBe(`${RTC_LOG_PREFIX} dial start peer=aa role=offerer stun_count=2 turn_enabled=false`);
    const trace = createIceCandidateTrace();
    noteCandidate(trace, 'local', 'candidate:1 1 UDP 1 10.0.1.55 9 typ host');
    noteCandidate(trace, 'local', 'candidate:2 1 UDP 1 203.0.113.44 9 typ srflx');
    noteCandidate(trace, 'remote', 'candidate:3 1 UDP 1 198.51.100.2 9 typ relay');
    expect(iceTypesOf(trace, 'local')).toEqual(['host', 'srflx']);
    expect(iceTypesOf(trace, 'remote')).toEqual(['relay']);
  });

  test('rate-limits repeated candidate lines with the same key', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      rtcLogRateLimited('k1', 'signal', { peer: 'p', kind: 'candidate' }, 60_000);
      rtcLogRateLimited('k1', 'signal', { peer: 'p', kind: 'candidate' }, 60_000);
      rtcLogRateLimited('k2', 'signal', { peer: 'p', kind: 'candidate' }, 60_000);
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[mesh][rtc] signal');
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  });

  test('rate-limits dial failed per peer and attaches an aggregated count', () => {
    resetRtcLogStateForTest();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      rtcLog('dial failed', { peer: 'p1', reason: 'datachannel' });
      rtcLog('dial failed', { peer: 'p1', reason: 'datachannel' });
      rtcLog('dial failed', { peer: 'p1', reason: 'datachannel' });
      rtcLog('dial failed', { peer: 'p2', reason: 'datachannel' });
    } finally {
      console.log = orig;
    }
    const p1 = lines.filter((line) => line.includes('peer=p1'));
    const p2 = lines.filter((line) => line.includes('peer=p2'));
    expect(p1).toHaveLength(1);
    expect(p2).toHaveLength(1);
    expect(p1[0]).toContain('count=1');
    expect(p1[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[mesh\]\[rtc\] dial failed/
    );
    expect(RTC_DIAL_FAILED_LOG_INTERVAL_MS).toBe(60_000);
  });
});
