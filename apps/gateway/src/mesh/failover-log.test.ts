import { describe, expect, test } from 'bun:test';
import {
  failoverCauseOf,
  formatFailoverAttempt,
  formatFailoverDone,
  formatFailoverStart,
  formatFailoverSummary,
} from './failover-log';

describe('failover-log', () => {
  test('maps close info to stream_close vs send_failed', () => {
    expect(failoverCauseOf({ code: 1011, reason: 'offline' })).toBe('stream_close');
    expect(failoverCauseOf({ code: 1011, reason: 'send-failed' })).toBe('send_failed');
    expect(failoverCauseOf(undefined)).toBe('stream_close');
  });

  test('formats start, attempt, done, and compact summary lines', () => {
    expect(
      formatFailoverStart({
        nodeId: 'n1',
        cid: 'tab-a',
        pumpId: '090a62e0',
        muxStreamId: 7,
        cause: 'stream_close',
        closeReason: 'offline',
        from: 'ws-secure',
        linkSinceAt: 1_700_000_000_000,
        queuedInputBytes: 12,
      })
    ).toBe(
      '[mesh][stream] failover_start node=n1 cid=tab-a stream=090a62e0 muxStreamId=7 cause=stream_close close_reason=offline from=ws-secure linkSinceAt=1700000000000 queued_input_bytes=12'
    );
    expect(
      formatFailoverAttempt({
        pumpId: '090a62e0',
        attempt: 1,
        getLinkMs: 4,
        openStreamMs: 9,
        helloWaitMs: 12,
        resumeWaitMs: 30,
      })
    ).toBe(
      '[mesh][stream] failover_attempt stream=090a62e0 attempt=1 getLink_ms=4 open_stream_ms=9 hello_wait_ms=12 resume_wait_ms=30'
    );
    expect(
      formatFailoverDone({
        pumpId: '090a62e0',
        durationMs: 842,
        to: 'ws-secure',
        resumed: 2,
        replayMode: 'canonical',
      })
    ).toBe(
      '[mesh][stream] failover_done stream=090a62e0 duration_ms=842 to=ws-secure resumed=2 replay_mode=canonical'
    );
    expect(
      formatFailoverSummary({
        pumpId: '090a62e0',
        durationMs: 842,
        cause: 'stream_close',
        closeReason: 'offline',
        from: 'ws-secure',
        to: 'ws-secure',
        eventLoopLagMs: 12,
        maxLagMs: 40,
      })
    ).toBe(
      '[mesh][stream] failover_summary stream=090a62e0 duration_ms=842 cause=stream_close close_reason=offline from=ws-secure to=ws-secure event_loop_lag_ms=12 max_lag_ms=40'
    );
  });
});
