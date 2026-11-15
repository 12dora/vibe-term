import { describe, expect, spyOn, test } from 'bun:test';

import { type ControlHealthEvent, ControlHealthReporter } from './control-health';

const info = { headAgeMs: 12_000, lastActivityAgoMs: 300 };

describe('ControlHealthReporter', () => {
  test('emits each transition once and logs slow / recovered with duration', () => {
    const events: ControlHealthEvent[] = [];
    let now = 1_000;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reporter = new ControlHealthReporter(
        'dev-1',
        (event) => events.push(event),
        () => now
      );
      reporter.report('recovered', info);
      reporter.report('slow', info);
      reporter.report('slow', info);
      expect(reporter.degraded).toBe(true);
      now = 6_000;
      reporter.report('recovered', info);
      reporter.report('recovered', info);
      expect(events).toEqual([
        { kind: 'slow', deviceId: 'dev-1', ...info },
        { kind: 'recovered', deviceId: 'dev-1', ...info },
      ]);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some((line) =>
          line.includes(
            '[tmux] control channel slow device=dev-1 head_age_ms=12000 last_activity_ms=300'
          )
        )
      ).toBe(true);
      expect(
        lines.some((line) =>
          line.includes('[tmux] control channel recovered device=dev-1 slow_ms=5000')
        )
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('stalled follows slow, slow after stalled is suppressed, recovery clears both', () => {
    const kinds: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reporter = new ControlHealthReporter('dev-1', (event) => kinds.push(event.kind));
      reporter.report('slow', info);
      reporter.report('stalled', info);
      reporter.report('slow', info);
      reporter.report('stalled', info);
      reporter.report('recovered', info);
      expect(kinds).toEqual(['slow', 'stalled', 'recovered']);
      expect(reporter.degraded).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test('a throwing listener does not break the reporter', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reporter = new ControlHealthReporter('dev-1', () => {
        throw new Error('boom');
      });
      reporter.report('slow', info);
      expect(reporter.degraded).toBe(true);
      expect(error).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
