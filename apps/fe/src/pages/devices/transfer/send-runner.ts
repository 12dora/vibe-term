// 提交的单飞与令牌控制，抽出来是为了不依赖 React 就能测。
//
// 两条规则：同一时刻只允许一次提交（两侧按钮共用一个 busy）；每次提交带一个令牌，
// 只有令牌仍是最新的那一次才允许写回状态——弹窗卸载或后续提交都会让旧回调失效。

import type { SendSide } from './send-side';
import { transferErrorKeyOf } from './send-transfer';

export interface SendRunnerHandlers {
  setSending: (side: SendSide | null) => void;
  setErrorKey: (key: string | null) => void;
}

export interface SendRunnerRequest {
  side: SendSide;
  run: () => Promise<unknown>;
  onSent: () => void;
}

export interface SendRunner {
  /** 已受理返回 true；正在飞时直接拒绝，不产生第二次提交。 */
  start: (request: SendRunnerRequest) => boolean;
  /** 卸载时作废在飞回调；服务端任务不受影响。 */
  discard: () => void;
}

export function createSendRunner(handlers: SendRunnerHandlers): SendRunner {
  let inFlight = false;
  let token = 0;

  return {
    start(request) {
      if (inFlight) return false;
      token += 1;
      const current = token;
      inFlight = true;
      handlers.setSending(request.side);
      handlers.setErrorKey(null);
      void request
        .run()
        .then(() => {
          if (token === current) request.onSent();
        })
        .catch((error: unknown) => {
          if (token === current) handlers.setErrorKey(transferErrorKeyOf(error));
        })
        .finally(() => {
          if (token !== current) return;
          inFlight = false;
          handlers.setSending(null);
        });
      return true;
    },
    discard() {
      token += 1;
      inFlight = false;
    },
  };
}
