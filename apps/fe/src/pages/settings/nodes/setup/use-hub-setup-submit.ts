// become-hub / join-hub 两个表单共用的提交流程：亮错误 → 校验闸门 → 提交 → toast → 等重启 → 跳登录页。
//
// 两个表单只在「校验哪些字段、调哪个 setup 端点、成功文案」上不同，其余顺序完全一致。
// 顺序本身是契约的一部分（见 submit.ts：先读 startedAt 再调端点），所以整段收在这里。

import type { ApiClient } from '@tmex/api-client';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type SetupUplinkKind, describeSetupError } from './error-messages';
import { isSetupBlocked, useSetupTransition } from './setup-transition';
import type { SubmitOutcome } from './submit';
import { type RestartWaiter, useRestartWaiter } from './use-restart-waiter';

export interface HubSetupSubmitOptions<T> {
  client: ApiClient;
  /** 当前草稿还有校验错误：点提交只亮错误，不发请求。 */
  hasErrors: boolean;
  submit: () => Promise<SubmitOutcome<T>>;
  successMessage: string;
  /** 重启完成后的动作，默认整页跳登录页。 */
  onRestarted: () => void;
  /**
   * 提交成功后是否等网关回来。纯中继重启后没有网页可回，等下去只会等到超时告警，
   * 因此那条路径直接不等（默认等）。
   */
  waitForRestart?: boolean;
  /** 上级形态：错误文案按 Hub / 中继分开取（默认 Hub）。 */
  uplink?: SetupUplinkKind;
}

export interface HubSetupSubmitHandle<T> {
  showErrors: boolean;
  /** 提交以外也要亮错误的入口（become-hub 的地址预检）。 */
  revealErrors: () => void;
  submitting: boolean;
  submitError: string | null;
  result: T | null;
  waiter: RestartWaiter;
  /** 另一条设置路径已提交：本表单必须锁上，否则请求必然 409。 */
  blocked: boolean;
  handleSubmit: (event: FormEvent) => Promise<void>;
}

export function useHubSetupSubmit<T>({
  client,
  hasErrors,
  submit,
  successMessage,
  onRestarted,
  waitForRestart = true,
  uplink = 'hub',
}: HubSetupSubmitOptions<T>): HubSetupSubmitHandle<T> {
  const { t } = useTranslation();
  const owner = useId();
  const transition = useSetupTransition();
  const blocked = isSetupBlocked(transition, owner);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const waiter = useRestartWaiter({ client });

  useEffect(() => {
    if (waiter.state === 'restarted') onRestarted();
  }, [waiter.state, onRestarted]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (blocked) return;
    setShowErrors(true);
    if (hasErrors) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submit();
      // 后端已经落锁：其余路径从这一刻起全部禁用，无论本条要不要等重启。
      transition.commit(owner);
      setResult(outcome.result);
      toast.success(successMessage);
      if (waitForRestart) waiter.start(outcome.previousStartedAt);
    } catch (error) {
      const message = describeSetupError(t, error, uplink);
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return {
    showErrors,
    revealErrors: () => setShowErrors(true),
    submitting,
    submitError,
    result,
    waiter,
    blocked,
    handleSubmit,
  };
}
