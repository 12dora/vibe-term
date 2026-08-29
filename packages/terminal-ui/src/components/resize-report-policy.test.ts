import { describe, expect, test } from 'bun:test';
import {
  type ResizeReportInput,
  type ResizeReportKind,
  decideResizeReport,
} from './resize-report-policy';

const SIZE = { cols: 80, rows: 24 };

function makeInput(overrides: Partial<ResizeReportInput> = {}): ResizeReportInput {
  return {
    kind: 'resize',
    force: false,
    gate: {
      sizingMode: 'report',
      deviceId: 'device-1',
      paneId: 'pane-1',
      deviceConnected: true,
      isSelectionInvalid: false,
    },
    now: 1_000,
    suppressUntil: 0,
    hasTerminal: true,
    lastReportedSize: null,
    measure: () => SIZE,
    ...overrides,
  };
}

function gateOverride(gate: Partial<ResizeReportInput['gate']>): Partial<ResizeReportInput> {
  return { gate: { ...makeInput().gate, ...gate } };
}

describe('decideResizeReport', () => {
  test('reports the measured size with the requested callback', () => {
    expect(decideResizeReport(makeInput())).toEqual({
      action: 'report',
      size: SIZE,
      callback: 'resize',
    });
    expect(decideResizeReport(makeInput({ kind: 'sync' }))).toEqual({
      action: 'report',
      size: SIZE,
      callback: 'sync',
    });
  });

  const skipCases: [string, Partial<ResizeReportInput>][] = [
    ['follow mode never reports', gateOverride({ sizingMode: 'follow' })],
    ['missing device id', gateOverride({ deviceId: '' })],
    ['missing pane id', gateOverride({ paneId: '' })],
    ['disconnected device', gateOverride({ deviceConnected: false })],
    ['invalid selection on a resize', gateOverride({ isSelectionInvalid: true })],
    ['detached terminal', { hasTerminal: false }],
    ['inside the suppression window', { suppressUntil: 1_001 }],
  ];

  for (const [label, overrides] of skipCases) {
    test(`skips: ${label}`, () => {
      expect(decideResizeReport(makeInput(overrides))).toEqual({ action: 'skip' });
    });
  }

  test('skips without measuring when a gate rejects the request', () => {
    let measured = 0;
    const decision = decideResizeReport(
      makeInput({
        ...gateOverride({ sizingMode: 'follow' }),
        measure: () => {
          measured += 1;
          return SIZE;
        },
      })
    );
    expect(decision).toEqual({ action: 'skip' });
    expect(measured).toBe(0);
  });

  test('still syncs while the selection is invalid', () => {
    const input = makeInput({ kind: 'sync', ...gateOverride({ isSelectionInvalid: true }) });
    expect(decideResizeReport(input)).toEqual({
      action: 'report',
      size: SIZE,
      callback: 'sync',
    });
  });

  test('follow mode outranks force', () => {
    const input = makeInput({ force: true, ...gateOverride({ sizingMode: 'follow' }) });
    expect(decideResizeReport(input)).toEqual({ action: 'skip' });
  });

  test('force ignores the suppression window but not the connection gates', () => {
    expect(decideResizeReport(makeInput({ force: true, suppressUntil: 5_000 }))).toEqual({
      action: 'report',
      size: SIZE,
      callback: 'resize',
    });
    const disconnected = makeInput({
      force: true,
      suppressUntil: 5_000,
      ...gateOverride({ deviceConnected: false }),
    });
    expect(decideResizeReport(disconnected)).toEqual({ action: 'skip' });
  });

  test('leaves the suppression window at its exact expiry', () => {
    expect(decideResizeReport(makeInput({ suppressUntil: 1_000 })).action).toBe('report');
  });

  test('skips when the size cannot be measured', () => {
    expect(decideResizeReport(makeInput({ measure: () => null }))).toEqual({ action: 'skip' });
  });

  test('applies the size locally when it repeats the last reported one', () => {
    const input = makeInput({ lastReportedSize: { ...SIZE } });
    expect(decideResizeReport(input)).toEqual({ action: 'localOnly', size: SIZE });
  });

  test('reports again when force is set on an unchanged size', () => {
    const input = makeInput({ force: true, lastReportedSize: { ...SIZE } });
    expect(decideResizeReport(input)).toEqual({
      action: 'report',
      size: SIZE,
      callback: 'resize',
    });
  });

  test('reports when only one dimension changed', () => {
    const cols = makeInput({ lastReportedSize: { cols: 79, rows: 24 } });
    const rows = makeInput({ lastReportedSize: { cols: 80, rows: 23 } });
    expect(decideResizeReport(cols).action).toBe('report');
    expect(decideResizeReport(rows).action).toBe('report');
  });

  test('keeps the callback kind aligned with the request kind', () => {
    const kinds: ResizeReportKind[] = ['resize', 'sync'];
    for (const kind of kinds) {
      const decision = decideResizeReport(makeInput({ kind }));
      expect(decision.action === 'report' && decision.callback).toBe(kind);
    }
  });
});
