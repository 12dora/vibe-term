import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import { buildTermViewportMessage, buildTmuxCreateWindow } from './message-builder';

describe('buildTermViewportMessage', () => {
  test('encodes KIND_TERM_VIEWPORT with geometry and visibility', () => {
    const message = buildTermViewportMessage({
      deviceId: 'dev-1',
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: true,
    });
    expect(message.kind).toBe(wsBorsh.KIND_TERM_VIEWPORT);
    expect(wsBorsh.decodePayload(wsBorsh.schema.TermViewportSchema, message.payload)).toEqual({
      deviceId: 'dev-1',
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: true,
    });
  });
});

describe('buildTmuxCreateWindow', () => {
  test('attached create-window keeps the historical kind and payload', () => {
    const attached = buildTmuxCreateWindow('dev-1', 'shell', '/tmp');
    expect(attached.kind).toBe(wsBorsh.KIND_TMUX_CREATE_WINDOW);
    expect(wsBorsh.decodePayload(wsBorsh.schema.TmuxCreateWindowSchema, attached.payload)).toEqual({
      deviceId: 'dev-1',
      name: 'shell',
      cwd: '/tmp',
    });
    const legacy = wsBorsh.encodePayload(wsBorsh.schema.TmuxCreateWindowSchema, {
      deviceId: 'dev-1',
      name: 'shell',
      cwd: '/tmp',
    });
    expect(attached.payload).toEqual(legacy);
  });

  test('detached create-window uses KIND_TMUX_CREATE_WINDOW_DETACHED', () => {
    const detached = buildTmuxCreateWindow('dev-1', 'vt-run', '/home', true);
    expect(detached.kind).toBe(wsBorsh.KIND_TMUX_CREATE_WINDOW_DETACHED);
    expect(
      wsBorsh.decodePayload(wsBorsh.schema.TmuxCreateWindowDetachedSchema, detached.payload)
    ).toEqual({
      deviceId: 'dev-1',
      name: 'vt-run',
      cwd: '/home',
    });
  });
});
