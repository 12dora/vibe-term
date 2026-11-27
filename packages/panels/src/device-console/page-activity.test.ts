import { describe, expect, test } from 'bun:test';
import { createPageActivityTracker, createSizeReportGate } from './page-activity';

function fakeTarget() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    visibilityState: 'visible' as string | undefined,
    addEventListener(type: string, listener: () => void) {
      const set = handlers.get(type) ?? new Set();
      set.add(listener);
      handlers.set(type, set);
    },
    removeEventListener(type: string, listener: () => void) {
      handlers.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const handler of [...(handlers.get(type) ?? [])]) handler();
    },
  };
}

describe('createPageActivityTracker', () => {
  test('is active while visible and not suspended', () => {
    expect(createPageActivityTracker(fakeTarget(), fakeTarget()).isActive()).toBe(true);
  });

  test('is active without a document (SSR)', () => {
    expect(createPageActivityTracker(null, null).isActive()).toBe(true);
  });

  test('pagehide and freeze suspend even though visibilityState stays visible', () => {
    const doc = fakeTarget();
    const win = fakeTarget();
    const tracker = createPageActivityTracker(doc, win);

    win.emit('pagehide');
    expect(tracker.isActive()).toBe(false);
    win.emit('pageshow');
    expect(tracker.isActive()).toBe(true);

    doc.emit('freeze');
    expect(tracker.isActive()).toBe(false);
    doc.emit('resume');
    expect(tracker.isActive()).toBe(true);
  });

  test('hidden document stays inactive after pageshow', () => {
    const doc = fakeTarget();
    const win = fakeTarget();
    const tracker = createPageActivityTracker(doc, win);

    win.emit('pagehide');
    doc.visibilityState = 'hidden';
    win.emit('pageshow');

    expect(tracker.isActive()).toBe(false);
  });

  test('a visible visibilitychange clears a missed resume', () => {
    const doc = fakeTarget();
    const tracker = createPageActivityTracker(doc, fakeTarget());

    doc.emit('freeze');
    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');

    expect(tracker.isActive()).toBe(true);
  });

  test('notifies listeners with the event and resulting state, until disposed', () => {
    const doc = fakeTarget();
    const win = fakeTarget();
    const tracker = createPageActivityTracker(doc, win);
    const seen: Array<[string, boolean]> = [];
    tracker.subscribe((event, active) => seen.push([event, active]));

    win.emit('pagehide');
    win.emit('pageshow');
    tracker.dispose();
    win.emit('pagehide');

    expect(seen).toEqual([
      ['pagehide', false],
      ['pageshow', true],
    ]);
  });
});

describe('createSizeReportGate', () => {
  function setup() {
    let active = true;
    const sent: Array<[string, number, number]> = [];
    const gate = createSizeReportGate({
      isActive: () => active,
      dispatch: (kind, cols, rows) => sent.push([kind, cols, rows]),
    });
    return {
      gate,
      sent,
      setActive(value: boolean) {
        active = value;
      },
    };
  }

  test('passes reports through while the page is active', () => {
    const { gate, sent } = setup();

    gate.submit('resize', 100, 30);
    gate.submit('sync', 100, 30);

    expect(sent).toEqual([
      ['resize', 100, 30],
      ['sync', 100, 30],
    ]);
  });

  test('holds reports while hidden and flushes only the latest once active', () => {
    const { gate, sent, setActive } = setup();

    setActive(false);
    gate.submit('resize', 100, 30);
    gate.submit('sync', 120, 40);
    gate.flush();
    expect(sent).toEqual([]);

    setActive(true);
    gate.flush();
    gate.flush();

    expect(sent).toEqual([['resize', 120, 40]]);
  });

  test('a held sync stays a sync', () => {
    const { gate, sent, setActive } = setup();

    setActive(false);
    gate.submit('sync', 90, 20);
    setActive(true);
    gate.flush();

    expect(sent).toEqual([['sync', 90, 20]]);
  });

  test('a fresh report while active supersedes the held one', () => {
    const { gate, sent, setActive } = setup();

    setActive(false);
    gate.submit('resize', 100, 30);
    setActive(true);
    gate.submit('resize', 110, 31);
    gate.flush();

    expect(sent).toEqual([['resize', 110, 31]]);
  });

  test('discard drops the held report', () => {
    const { gate, sent, setActive } = setup();

    setActive(false);
    gate.submit('resize', 100, 30);
    gate.discard();
    setActive(true);
    gate.flush();

    expect(sent).toEqual([]);
  });
});
