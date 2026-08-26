import { describe, expect, test } from 'bun:test';

import type {
  PaneStreamNotification,
  PaneStreamParserOptions,
  PromptMarker,
} from '../pane-stream-parser';
import { emitOsc, emitTitle } from './osc-handlers';
import { createParserState } from './parser-state';

const encoder = new TextEncoder();

function collectOptions() {
  const titles: string[] = [];
  const paths: string[] = [];
  const notifications: PaneStreamNotification[] = [];
  const prompts: PromptMarker[] = [];
  const clipboard: string[] = [];
  const options: PaneStreamParserOptions = {
    onTitle: (title) => titles.push(title),
    onCurrentPath: (path) => paths.push(path),
    onBell: () => {},
    onNotification: (notification) => notifications.push(notification),
    onPromptMarker: (marker) => prompts.push(marker),
    onClipboardWrite: (text) => clipboard.push(text),
  };
  return { options, titles, paths, notifications, prompts, clipboard };
}

function emit(kind: string, payload: string) {
  const collected = collectOptions();
  const state = createParserState();
  state.oscKind = kind;
  state.oscPayloadBytes = Array.from(encoder.encode(payload));
  emitOsc(state, collected.options);
  return { state, ...collected };
}

describe('emitTitle', () => {
  test('trims and skips empty titles', () => {
    const titles: string[] = [];
    emitTitle(Array.from(encoder.encode('  ')), (title) => titles.push(title));
    emitTitle(Array.from(encoder.encode('  dev  ')), (title) => titles.push(title));
    expect(titles).toEqual(['dev']);
  });
});

describe('emitOsc', () => {
  test('OSC 0/1/2 emit titles', () => {
    expect(emit('0', 'alpha').titles).toEqual(['alpha']);
    expect(emit('1', 'beta').titles).toEqual(['beta']);
    expect(emit('2', 'gamma').titles).toEqual(['gamma']);
  });

  test('OSC 7 file URL emits current path', () => {
    expect(emit('7', 'file://host/work/my%20repo').paths).toEqual(['/work/my repo']);
    expect(emit('7', 'not-a-url').paths).toEqual([]);
    expect(emit('7', 'http://host/work').paths).toEqual([]);
  });

  test('OSC 9 notifies unless progress payload', () => {
    expect(emit('9', 'hello').notifications).toEqual([{ source: 'osc9', body: 'hello' }]);
    expect(emit('9', '4;1;42').notifications).toEqual([]);
    expect(emit('9', '4').notifications).toEqual([]);
  });

  test('OSC 99 aggregates fragments by id until done', () => {
    const collected = collectOptions();
    const state = createParserState();
    state.oscKind = '99';
    state.oscPayloadBytes = Array.from(encoder.encode('i=7:d=0:p=title;Hello'));
    emitOsc(state, collected.options);
    state.oscPayloadBytes = Array.from(encoder.encode('i=7:d=0:p=body;World'));
    emitOsc(state, collected.options);
    expect(collected.notifications).toEqual([]);
    state.oscPayloadBytes = Array.from(encoder.encode('i=7:d=1;'));
    emitOsc(state, collected.options);
    expect(collected.notifications).toEqual([{ source: 'osc99', title: 'Hello', body: 'World' }]);
  });

  test('OSC 777 notify splits title and body on first two semicolons', () => {
    expect(emit('777', 'notify;Build;All;passed').notifications).toEqual([
      { source: 'osc777', title: 'Build', body: 'All;passed' },
    ]);
    expect(emit('777', 'other;x;y').notifications).toEqual([]);
  });

  test('OSC 1337 only emits RequestAttention variants', () => {
    expect(emit('1337', 'RequestAttention=yes').notifications).toEqual([
      { source: 'osc1337', body: 'RequestAttention' },
    ]);
    expect(emit('1337', 'SetMark').notifications).toEqual([]);
  });

  test('OSC 52 decodes clipboard writes and ignores queries', () => {
    expect(emit('52', 'c;aGVsbG8=').clipboard).toEqual(['hello']);
    expect(emit('52', 'c;?').clipboard).toEqual([]);
    expect(emit('52', 'c;').clipboard).toEqual([]);
    expect(emit('52', 'nosep').clipboard).toEqual([]);
  });

  test('OSC 133 prompt markers', () => {
    expect(emit('133', 'C').prompts).toEqual([{ kind: 'C', exitCode: null, params: [] }]);
    expect(emit('133', 'D;137;tmex=abc').prompts).toEqual([
      { kind: 'D', exitCode: 137, params: ['137', 'tmex=abc'] },
    ]);
    expect(emit('133', 'Z').prompts).toEqual([]);
  });

  test('unknown kind is a no-op', () => {
    const result = emit('12', 'query');
    expect(result.titles).toEqual([]);
    expect(result.notifications).toEqual([]);
    expect(result.clipboard).toEqual([]);
  });
});
