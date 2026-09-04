// 退出对话框的文案路由：标题与后果按「从哪个角色退、退到哪」分档，不能混着讲。

import { describe, expect, test } from 'bun:test';
import zhCN from '@tmex/shared/i18n/locales/zh_CN.json';
import {
  type LeaveDialogRequest,
  isLeaveToPureRelay,
  leaveDialogConsequencesKey,
  leaveDialogTitleKey,
} from './leave-dialog';

function request(overrides: Partial<LeaveDialogRequest> = {}): LeaveDialogRequest {
  return {
    kind: 'leave',
    from: 'node',
    target: 'standalone',
    targetRole: 'standalone',
    intent: null,
    ...overrides,
  };
}

describe('leaveDialogTitleKey', () => {
  test('退到 standalone / 切角色 / 换 hub 各用自己的标题', () => {
    expect(leaveDialogTitleKey(request())).toBe('nodes.membership.leaveConfirm.title');
    expect(leaveDialogTitleKey(request({ kind: 'switch', target: 'hub,node' }))).toBe(
      'nodes.membership.switchConfirm.title'
    );
    expect(leaveDialogTitleKey(request({ kind: 'change-hub' }))).toBe(
      'nodes.membership.changeHubConfirm.title'
    );
  });

  test('只退 mesh、保留中继：单独一套标题', () => {
    expect(
      leaveDialogTitleKey(request({ from: 'relay,node', target: 'relay', targetRole: 'relay' }))
    ).toBe('nodes.membership.leaveToRelayConfirm.title');
  });
});

describe('leaveDialogConsequencesKey', () => {
  test('纯 node 与 hub 兼节点各说各的', () => {
    expect(leaveDialogConsequencesKey(request())).toBe('nodes.membership.consequencesNode');
    expect(leaveDialogConsequencesKey(request({ from: 'hub,node' }))).toBe(
      'nodes.membership.consequencesHub'
    );
  });

  test('relay,node → relay：中继服务与租户保留', () => {
    expect(
      leaveDialogConsequencesKey(
        request({ from: 'relay,node', target: 'relay', targetRole: 'relay' })
      )
    ).toBe('nodes.membership.consequencesRelayKeepService');
  });

  test('relay,node → standalone / 其它角色：中继服务一并清除', () => {
    for (const target of ['standalone', 'node', 'hub,node'] as const) {
      expect(
        leaveDialogConsequencesKey(
          request({
            kind: target === 'standalone' ? 'leave' : 'switch',
            from: 'relay,node',
            target,
            targetRole: 'standalone',
          })
        )
      ).toBe('nodes.membership.consequencesRelayReset');
    }
  });
});

describe('中文文案把后果讲全', () => {
  const membership = zhCN.translation.nodes.membership;

  test('保留中继那一档明说中继与租户不动', () => {
    expect(membership.leaveToRelayConfirm.description).toContain('中继服务');
    expect(membership.consequencesRelayKeepService).toContain('保留');
  });

  test('清除那一档明说不可恢复', () => {
    expect(membership.consequencesRelayReset).toContain('不可恢复');
  });

  test('切角色说明先退出当前 mesh', () => {
    expect(membership.switchConfirm.description).toContain('先退出');
  });
});

describe('isLeaveToPureRelay', () => {
  test('只有「退出 mesh、保留中继」那一档算', () => {
    expect(
      isLeaveToPureRelay(request({ from: 'relay,node', target: 'relay', targetRole: 'relay' }))
    ).toBe(true);
    expect(isLeaveToPureRelay(request())).toBe(false);
    expect(
      isLeaveToPureRelay(request({ kind: 'switch', from: 'relay,node', target: 'hub,node' }))
    ).toBe(false);
  });
});

describe('退成纯中继的告警文案', () => {
  const confirm = zhCN.translation.nodes.membership.leaveToRelayConfirm;

  test('讲清网页会消失、只剩命令行', () => {
    expect(confirm.webGone).toContain('不再提供网页');
    expect(confirm.webGone).toContain('命令行');
  });

  test('给出把网页要回来的办法', () => {
    expect(confirm.restore).toContain('恢复网页');
  });
});
