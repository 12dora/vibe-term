// 退出 mesh 的编排本体：纯函数 + 全部依赖注入，React 只负责接线（见 `use-leave-mesh.ts`）。
//
// 步骤顺序不是随便排的：
//   1. 纯 node 先尽力自吊销（要弹凭据对话框，可能停留很久）；
//   2. 自吊销之后、`leave` 之前才读 `/healthz.startedAt` 作为重启基线——凭据框开着的这段时间
//      网关完全可能被别的原因重启掉，提前采样会让基线一上来就是「已变化」，`leave` 一返回就
//      误判重启完成；
//   3. 记号同样卡在 `leave` 之前写：写早了，一旦退出被拒，这条记号会留到下一次无关的退出里
//      被消费掉，把用户莫名其妙地丢进旧向导；
//   4. `leave` 之前置位「鉴权切换中」：响应回来时本机全部会话已作废，页面上任何在途请求都会
//      401，全局拦截器的 `/login` 跳转会把还在等重启的这段编排一起卸掉。这个标记一直保持到
//      整页硬跳转（换掉整个 JS 环境），只有退出被明确拒绝时才撤销。

import type { LocalLeaveTargetRole } from '@tmex/api-client/local/types';
import type { SetupIntentRecord } from './intent';
import type { MeshRole } from './role-transition';
import type { SelfRevokeOutcome } from './self-revoke';

export type LeavePhase =
  | 'idle'
  | 'confirming'
  | 'leaving'
  | 'restarting'
  | 'restarted'
  | 'timeout'
  | 'error';

/** 等重启的三种结局；与 `restart/wait-for-restart.ts` 的 `RestartOutcome` 同构。 */
export type LeaveRestartOutcome = 'restarted' | 'timeout' | 'aborted';

export type LeaveOutcome = LeaveRestartOutcome | 'failed';

export interface LeaveRequest {
  /** 当前角色，作为 `expectedRole` 发给后端做一致性校验。 */
  from: MeshRole;
  /** 退到哪：省略即 standalone；`relay` 保留中继运营状态。 */
  targetRole?: LocalLeaveTargetRole;
  /** 重启回 standalone 后要展开的向导路径；纯粹退出时为 null。 */
  intent: SetupIntentRecord | null;
}

export interface LeaveWorkflowDeps {
  /** 纯 node 的自吊销；`null` 表示不需要（hub 兼节点就是自己的 hub）。永不抛。 */
  revoke: (() => Promise<SelfRevokeOutcome>) | null;
  /** 重启基线：读 `/healthz.startedAt`，读不到给 null。必须自带超时。 */
  readStartedAt: () => Promise<number | null>;
  leave: (body: { expectedRole: MeshRole; targetRole?: LocalLeaveTargetRole }) => Promise<unknown>;
  waitForRestart: (previousStartedAt: number | null) => Promise<LeaveRestartOutcome>;
  /** 整页硬跳转回设置页。 */
  navigate: () => void;
  writeIntent: (intent: SetupIntentRecord) => void;
  clearIntent: () => void;
  beginAuthTransition: () => void;
  endAuthTransition: () => void;
  setPhase: (phase: LeavePhase) => void;
  onRevokeOutcome: (outcome: SelfRevokeOutcome) => void;
  onLeaveError: (error: unknown) => void;
  /**
   * 放开进入守卫。**只在退出被明确拒绝时调用**：请求一旦发出去（重启成功或等超时），
   * 成员关系已经被清掉了，再点一次就是对着空状态重放整条破坏性流程。
   */
  release: () => void;
  /** 采到的重启基线；「再查一次」要用同一个基线重跑等待。 */
  onBaseline?: (startedAt: number | null) => void;
}

/**
 * 同步的进入守卫。
 *
 * 两次点击之间 React 还没提交 `phase='leaving'`，只看 state 是拦不住第二次的：两条流程会去
 * 抢同一个凭据对话框，先来的那条把「被顶掉」当成用户取消，于是跳过自吊销继续退出。
 */
export interface InFlightGuard {
  /** 抢到返回 true；已经有人在跑返回 false。 */
  tryEnter(): boolean;
  release(): void;
}

export function createInFlightGuard(): InFlightGuard {
  let held = false;
  return {
    tryEnter() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
  };
}

export type RestartWaitDeps = Pick<LeaveWorkflowDeps, 'waitForRestart' | 'navigate' | 'setPhase'>;

/**
 * 等网关换代并跳走。抽出来是因为超时之后的「再查一次」要用同一条逻辑重跑，
 * 而**绝不能**把 `leave` 再发一遍。
 */
export async function awaitRestartAndNavigate(
  deps: RestartWaitDeps,
  previousStartedAt: number | null
): Promise<LeaveRestartOutcome> {
  deps.setPhase('restarting');
  const outcome = await deps.waitForRestart(previousStartedAt);
  if (outcome === 'restarted') {
    deps.setPhase('restarted');
    deps.navigate();
    return 'restarted';
  }
  // 超时是**已提交**之后的终态：退出请求已经成功，重来一次没有意义，只能让用户自己确认或刷新。
  if (outcome === 'timeout') deps.setPhase('timeout');
  return outcome;
}

export async function runLeaveWorkflow(
  deps: LeaveWorkflowDeps,
  request: LeaveRequest
): Promise<LeaveOutcome> {
  if (deps.revoke) {
    // 凭据弹层与确认对话框同为 z-50 且前者不走 portal，会被对话框盖住：确认身份期间先把对话框收起
    deps.setPhase('confirming');
    const outcome = await deps.revoke();
    if (outcome.kind !== 'revoked') deps.onRevokeOutcome(outcome);
  }
  deps.setPhase('leaving');

  const previousStartedAt = await deps.readStartedAt();
  deps.onBaseline?.(previousStartedAt);

  if (request.intent) deps.writeIntent(request.intent);
  else deps.clearIntent();

  deps.beginAuthTransition();
  try {
    // `targetRole` 只在保留中继时发出去：standalone 是后端默认值，多发一个字段只会让日志更难读。
    await deps.leave(
      request.targetRole === 'relay'
        ? { expectedRole: request.from, targetRole: 'relay' }
        : { expectedRole: request.from }
    );
  } catch (error) {
    // 明确被拒 = 什么都没发生：记号必须撤掉，鉴权也没有切换，页面回到可重试的状态。
    deps.clearIntent();
    deps.endAuthTransition();
    deps.onLeaveError(error);
    deps.setPhase('error');
    deps.release();
    return 'failed';
  }

  return awaitRestartAndNavigate(deps, previousStartedAt);
}
