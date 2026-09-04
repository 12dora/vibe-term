// 「本机作为中继」提交前的那道闸门。
//
// 纯中继一旦提交就没有网页可回，也无法在网页里改回来，因此这一档必须先确认；中继兼节点
// 重启后还有登录页，直接提交。判定与状态迁移都抽在这里：无 DOM 的测试环境点不了按钮，
// 组件里内联的话「取消之后到底发没发请求」只能靠读代码猜（与 `DirectMutationController`
// 同一套做法）。

import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { type BecomeRelayValues, hasErrors, validateBecomeRelay } from './validation';

export type BecomeRelaySubmitPlan =
  /** 草稿还有校验错误：只亮错误，既不确认也不发请求。 */
  | 'invalid'
  /** 纯中继：先确认。 */
  | 'confirm'
  /** 中继兼节点：直接提交。 */
  | 'submit';

export function pureRelaySubmitPlan(
  values: BecomeRelayValues,
  nodeEnv: LocalStatusResponse['nodeEnv']
): BecomeRelaySubmitPlan {
  if (hasErrors(validateBecomeRelay(values, nodeEnv))) return 'invalid';
  return values.alsoNode ? 'submit' : 'confirm';
}

export type BecomeRelayGateEvent =
  | { kind: 'submit'; plan: BecomeRelaySubmitPlan }
  | { kind: 'confirm' }
  | { kind: 'cancel' };

export interface BecomeRelayGateStep {
  /** 确认框该不该开着。 */
  confirming: boolean;
  /** 现在就发 `POST /api/setup/relay`。 */
  submit: boolean;
}

export function becomeRelayGate(event: BecomeRelayGateEvent): BecomeRelayGateStep {
  if (event.kind === 'confirm') return { confirming: false, submit: true };
  if (event.kind === 'cancel') return { confirming: false, submit: false };
  return {
    confirming: event.plan === 'confirm',
    submit: event.plan === 'submit',
  };
}
