// `WATCH_EVENT`（来源机直投）与转发件（汇聚节点的 `NOTIFY_EVENT`）必须拼出同一个去重键，
// 否则同一次触发会弹两条 toast。这里把两边的字段来源摆在一起对齐。

import { describe, expect, test } from 'bun:test';
import { toastDedupeKey } from '@tmex/notifications';
import { wsBorsh } from '@tmex/shared';
import { watchToastIdentity } from './watch-events-init';

const NODE_B = 'bb'.repeat(16);

describe('直投事件身份', () => {
  test('数字事件类型折回 WebhookEvent 的命名', () => {
    const decoded = { ruleId: 'r1', deviceId: 'd1', paneId: '%2' };
    expect(
      watchToastIdentity(NODE_B, { ...decoded, eventType: wsBorsh.WATCH_EVENT_TRIGGERED })
    ).toEqual({
      eventType: 'watch_triggered',
      nodeId: NODE_B,
      deviceId: 'd1',
      paneId: '%2',
      ruleId: 'r1',
    });
    expect(
      watchToastIdentity(NODE_B, { ...decoded, eventType: wsBorsh.WATCH_EVENT_MODEL_UNAVAILABLE })
        ?.eventType
    ).toBe('watch_model_unavailable');
    expect(
      watchToastIdentity(NODE_B, { ...decoded, eventType: wsBorsh.WATCH_EVENT_RULE_ERROR })
        ?.eventType
    ).toBe('watch_rule_error');
  });

  test('不认识的事件类型不认领 toast', () => {
    expect(
      watchToastIdentity(NODE_B, { ruleId: 'r', deviceId: 'd', paneId: '%1', eventType: 99 })
    ).toBeNull();
  });

  test('与转发件（WebhookEvent 的 device.id / tmux.paneId / payload.ruleId）同键', () => {
    const direct = watchToastIdentity(NODE_B, {
      ruleId: 'r1',
      deviceId: 'd1',
      paneId: '%2',
      eventType: wsBorsh.WATCH_EVENT_TRIGGERED,
    });
    const forwarded = {
      eventType: 'watch_triggered',
      nodeId: NODE_B,
      deviceId: 'd1',
      paneId: '%2',
      ruleId: 'r1',
    };
    expect(toastDedupeKey(direct as never)).toBe(toastDedupeKey(forwarded));
  });
});
