// 中继模式下那一摞提醒的次序与内容：五种情况各一条，各带一个动作。
//
// 拆成纯函数是为了能直接断言「哪种状态出哪几条、什么次序」：以前这段是三个组件里散落的
// 条件渲染，改一处就得靠整卡静态渲染去猜。

import type { NoticeTone } from '../card-parts';

export type RelayNoticeKind = 'kicked' | 'readmit' | 'metaPending' | 'packPending' | 'notAttached';

export interface RelayNoticeSpec {
  kind: RelayNoticeKind;
  tone: NoticeTone;
  testId: string;
  key: string;
  params?: { count: number };
  /** 没有动作的那一条（未挂载）只陈述事实，处理办法在下面的操作区。 */
  action?: { key: string; testId: string };
}

export interface RelayNoticeInput {
  kicked: boolean;
  readmitPending: number;
  metaPending: number;
  packPending: boolean;
  /** 管理写入是否可用；中继模式下等价于「挂上了至少一条中继」。 */
  writable: boolean;
}

export function relayNotices(input: RelayNoticeInput): RelayNoticeSpec[] {
  const notices: RelayNoticeSpec[] = [];
  if (input.kicked) {
    notices.push({
      kind: 'kicked',
      tone: 'danger',
      testId: 'nodes-relay-reauth',
      key: 'relay.tenant.reauth.notice',
      action: { key: 'relay.tenant.reauth.action', testId: 'nodes-relay-reauth-action' },
    });
  }
  if (input.readmitPending > 0) {
    notices.push({
      kind: 'readmit',
      tone: 'warning',
      testId: 'nodes-relay-readmit',
      key: 'nodes.readmit.notice',
      params: { count: input.readmitPending },
      action: { key: 'nodes.readmit.action', testId: 'nodes-relay-readmit-action' },
    });
  }
  if (input.metaPending > 0) {
    notices.push({
      kind: 'metaPending',
      tone: 'warning',
      testId: 'nodes-relay-meta-pending',
      key: 'relay.tenant.metaKey.pending',
      params: { count: input.metaPending },
      action: { key: 'relay.tenant.metaKey.retry', testId: 'nodes-relay-meta-retry' },
    });
  }
  if (input.packPending) {
    notices.push({
      kind: 'packPending',
      tone: 'warning',
      testId: 'nodes-relay-pack-pending',
      key: 'relay.tenant.pack.pending',
      action: { key: 'relay.tenant.pack.retry', testId: 'nodes-relay-pack-retry' },
    });
  }
  // 令牌失效那一条已经把「连不上」说清楚了，不再补一条更笼统的。
  if (!input.writable && !input.kicked) {
    notices.push({
      kind: 'notAttached',
      tone: 'muted',
      testId: 'nodes-relay-detached',
      key: 'relay.tenant.notAttached',
    });
  }
  return notices;
}
