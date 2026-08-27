import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { sessionStateStore } from './borsh/session-state';
import {
  deliverBell,
  deliverGenericEvent,
  deliverNotification,
  isEmptyNotification,
} from './legacy-event-delivery';
import { createBorshTestWs } from './test-helpers';

describe('legacy event delivery', () => {
  test('treats notifications without title or body as empty', () => {
    expect(isEmptyNotification('notification', { source: 'osc9', body: '' })).toBe(true);
    expect(isEmptyNotification('notification', { title: 'Build', body: '' })).toBe(false);
    expect(isEmptyNotification('bell', { paneId: '%1' })).toBe(false);
  });

  test('deliverBell and deliverNotification honor per-client throttle', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const allowed = createBorshTestWs({ session: true });
    const blocked = createBorshTestWs({ session: true });
    const originalBell = sessionStateStore.shouldAllowBell.bind(sessionStateStore);
    const originalNotification = sessionStateStore.shouldAllowNotification.bind(sessionStateStore);
    sessionStateStore.shouldAllowBell = (ws) => ws === allowed;
    sessionStateStore.shouldAllowNotification = (ws) => ws === allowed;

    try {
      const bellAttempts = deliverBell(
        [allowed, blocked],
        payload,
        'device-a',
        { paneId: '%1' },
        6,
        {
          sendEnvelope(ws, kind, bytes) {
            ws.send(bytes);
            expect(kind).toBe(wsBorsh.KIND_TMUX_EVENT);
          },
        }
      );
      const notificationAttempts = deliverNotification(
        [allowed, blocked],
        payload,
        'device-a',
        { paneId: '%1', source: 'osc777' },
        3,
        {
          sendEnvelope(ws) {
            ws.send(payload);
          },
        }
      );
      expect(bellAttempts).toBe(1);
      expect(notificationAttempts).toBe(1);
      expect(allowed.sent).toHaveLength(2);
      expect(blocked.sent).toHaveLength(0);
    } finally {
      sessionStateStore.shouldAllowBell = originalBell;
      sessionStateStore.shouldAllowNotification = originalNotification;
    }
  });

  test('deliverGenericEvent fans out to every client', () => {
    const payload = new Uint8Array([9]);
    const a = createBorshTestWs();
    const b = createBorshTestWs();
    const attempts = deliverGenericEvent([a, b], payload, {
      sendEnvelope(ws) {
        ws.send(payload);
      },
    });
    expect(attempts).toBe(2);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });
});
