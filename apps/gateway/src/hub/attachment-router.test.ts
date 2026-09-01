import { describe, expect, test } from 'bun:test';
import {
  ATTACHMENT_KEEPALIVE_MS,
  ATTACHMENT_MAX_ENTRIES,
  ATTACHMENT_TTL_MS,
  AttachmentRouter,
} from './attachment-router';
import { AttachmentSnapshotAssembler, paginateHubAttachments } from './hub-attachments';

const HUB_A = 'aa'.repeat(16);
const HUB_B = 'bb'.repeat(16);
const NODE_C = 'cc'.repeat(16);
const NODE_D = 'dd'.repeat(16);

describe('AttachmentRouter', () => {
  test('本地 attach/detach 与 lookup', () => {
    let now = 1_000;
    const router = new AttachmentRouter({ selfHubId: () => HUB_A, now: () => now });
    expect(router.lookup(NODE_C)).toBeUndefined();
    router.attachLocal(NODE_C);
    expect(router.lookup(NODE_C)).toEqual({
      hubId: HUB_A,
      version: 1,
      lastSeen: 1_000,
    });
    expect(router.attachedHubId(NODE_C)).toBe(HUB_A);
    now = 2_000;
    router.refreshLocal(NODE_C);
    expect(router.lookup(NODE_C)?.lastSeen).toBe(2_000);
    expect(router.detachLocal(NODE_C)).toBe(true);
    expect(router.lookup(NODE_C)).toBeUndefined();
    expect(router.detachLocal(NODE_C)).toBe(false);
  });

  test('远端 delta 合并：更高 lastSeen 覆盖；full 替换该 hub 的条目', () => {
    let now = 5_000;
    const router = new AttachmentRouter({ selfHubId: () => HUB_A, now: () => now });
    expect(router.applyFromHub(HUB_B, [{ nodeId: NODE_D, attached: true }], { revision: 1 })).toBe(
      'applied'
    );
    expect(router.attachedHubId(NODE_D)).toBe(HUB_B);

    now = 6_000;
    router.attachLocal(NODE_C);
    now = 7_000;
    expect(
      router.applyFromHub(HUB_B, [{ nodeId: NODE_C, attached: true, hubId: HUB_B }], {
        revision: 2,
      })
    ).toBe('applied');
    expect(router.attachedHubId(NODE_C)).toBe(HUB_B);

    now = 8_000;
    expect(router.applyFromHub(HUB_B, [{ nodeId: NODE_D, attached: false }], { revision: 3 })).toBe(
      'applied'
    );
    expect(router.lookup(NODE_D)).toBeUndefined();

    now = 9_000;
    router.applyFromHub(HUB_B, [{ nodeId: NODE_C, attached: true, hubId: HUB_B }], {
      revision: 4,
      full: true,
    });
    expect(router.attachedHubId(NODE_C)).toBe(HUB_B);
    expect(router.lookup(NODE_D)).toBeUndefined();
  });

  test('写者 union 带 hubId；忽略过期 revision；过期条目被清掉', () => {
    let now = 10_000;
    const router = new AttachmentRouter({ selfHubId: () => HUB_B, now: () => now });
    router.applyFromHub(HUB_A, [{ nodeId: NODE_C, attached: true, hubId: HUB_A }], {
      revision: 2,
      full: true,
    });
    expect(router.applyFromHub(HUB_A, [{ nodeId: NODE_D, attached: true }], { revision: 1 })).toBe(
      'ignored'
    );
    expect(router.lookup(NODE_D)).toBeUndefined();

    now = 10_000 + ATTACHMENT_TTL_MS + 1;
    expect(router.expire()).toEqual([NODE_C]);
    expect(router.lookup(NODE_C)).toBeUndefined();
  });

  test('本地条目 refresh 后不过期；dropHub 清掉指向该 hub 的远端条目', () => {
    let now = 1_000;
    const router = new AttachmentRouter({ selfHubId: () => HUB_A, now: () => now });
    router.attachLocal(NODE_C);
    router.applyFromHub(HUB_B, [{ nodeId: NODE_D, attached: true }], { revision: 1 });
    now = 1_000 + ATTACHMENT_TTL_MS - 1;
    router.refreshLocal(NODE_C);
    now = 1_000 + ATTACHMENT_TTL_MS + 1;
    expect(router.expire().sort()).toEqual([NODE_D]);
    expect(router.attachedHubId(NODE_C)).toBe(HUB_A);

    router.applyFromHub(HUB_B, [{ nodeId: NODE_D, attached: true }], { revision: 2 });
    expect(router.dropHub(HUB_B)).toEqual([NODE_D]);
    expect(router.lookup(NODE_D)).toBeUndefined();
    expect(router.dropHub(HUB_A)).toEqual([]);
  });

  test('超过 4096 条时丢掉最旧的远端条目', () => {
    const now = 1_000;
    const router = new AttachmentRouter({ selfHubId: () => HUB_A, now: () => now });
    router.attachLocal(NODE_C);
    const extra = ATTACHMENT_MAX_ENTRIES;
    const entries = Array.from({ length: extra }, (_, i) => {
      const id = i.toString(16).padStart(32, '0');
      return { nodeId: id, attached: true as const };
    });
    expect(router.applyFromHub(HUB_B, entries, { revision: 1 })).toBe('applied');
    expect(router.size()).toBe(ATTACHMENT_MAX_ENTRIES);
    expect(router.attachedHubId(NODE_C)).toBe(HUB_A);
  });

  test('refreshHub 把安静但仍在线的远端路由撑过 TTL', () => {
    let now = 1_000;
    const router = new AttachmentRouter({ selfHubId: () => HUB_A, now: () => now });
    router.applyFromHub(HUB_B, [{ nodeId: NODE_D, attached: true }], { revision: 1 });
    now = 1_000 + ATTACHMENT_TTL_MS - 1;
    expect(router.refreshHub(HUB_B)).toBe(1);
    now = 1_000 + ATTACHMENT_TTL_MS + ATTACHMENT_KEEPALIVE_MS;
    expect(router.expire()).toEqual([]);
    expect(router.attachedHubId(NODE_D)).toBe(HUB_B);
    expect(ATTACHMENT_KEEPALIVE_MS).toBeLessThan(ATTACHMENT_TTL_MS);
  });

  test('分页 snapshot 在 final 页原子应用', () => {
    const entries = [
      { nodeId: NODE_C, attached: true, hubId: HUB_A },
      { nodeId: NODE_D, attached: true, hubId: HUB_B },
    ];
    const pages = paginateHubAttachments(entries, {
      revision: 3,
      snapshotId: 'snap-z',
      full: true,
    });
    expect(pages.at(-1)?.final).toBe(true);
    const assembler = new AttachmentSnapshotAssembler();
    expect(assembler.push(HUB_A, { ...pages[0]!, final: false, page: 0 })).toBeNull();
    const assembled = assembler.push(HUB_A, {
      t: 'hub.attachments',
      revision: 3,
      snapshotId: 'snap-z',
      page: 0,
      final: true,
      full: true,
      entries,
    });
    expect(assembled?.entries).toHaveLength(2);
    expect(assembled?.final).toBe(true);
  });
});
