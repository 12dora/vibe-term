// 窄屏接入节点记录卡：与宽表共用 testid。直接渲染卡片列表，不桩 matchMedia。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { RelayMembersCardList } = await import('./members-card-list');
const { relayMetricsMember } = await import('./relay-metrics-fixture');

describe('窄屏接入节点记录卡', () => {
  test('不渲染表格；容器与行的 testid 与宽表一致', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCardList members={[relayMetricsMember()]} now={0} />
    );
    expect(html).not.toContain('<table');
    expect(html).toContain('data-testid="relay-members-table"');
    expect(html).toContain('data-testid="relay-member-row-aabbccddeeff0011"');
    expect(html).toContain('data-online=""');
    expect(html).toContain('上海节点');
    expect(html).toContain('8.0 KB/s');
    expect(html).toContain('4.0 KB/s');
  });

  test('出 / 入速率允许折行，不再定死 15rem 列宽', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCardList members={[relayMetricsMember()]} now={0} />
    );
    expect(html).toContain('inline-flex flex-wrap items-center gap-1');
    expect(html).not.toContain('w-[15rem] min-w-[15rem]');
    expect(html).toContain('<span class="sr-only">common.direction.out</span>');
    expect(html).toContain('<span class="sr-only">common.direction.in</span>');
  });

  test('离线成员不写 data-online，与宽表行一致', () => {
    const html = renderToStaticMarkup(
      <RelayMembersCardList members={[relayMetricsMember({ online: false })]} now={0} />
    );
    expect(html).toContain('data-testid="relay-member-row-aabbccddeeff0011"');
    expect(html).not.toContain('data-online');
  });

  test('空态与筛没了的 testid 与宽表一致', () => {
    const empty = renderToStaticMarkup(<RelayMembersCardList members={[]} now={0} />);
    expect(empty).toContain('data-testid="relay-members-empty"');
    const filtered = renderToStaticMarkup(<RelayMembersCardList members={[]} now={0} filtered />);
    expect(filtered).toContain('data-testid="relay-members-no-match"');
  });
});
