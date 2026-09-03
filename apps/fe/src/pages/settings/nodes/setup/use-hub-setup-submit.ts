// become-hub / join-hub 两个表单共用的提交流程：亮错误 → 校验闸门 → 提交 → toast → 等重启 → 跳登录页。
//
// 两个表单只在「校验哪些字段、调哪个 setup 端点、成功文案」上不同，其余顺序完全一致。
// 顺序本身是契约的一部分（见 submit.ts：先读 startedAt 再调端点），所以整段收在这里。

import type { ApiClient } from '@tmex/api-client';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { describeSetupError } from './error-messages';
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
}

export interface HubSetupSubmitHandle<T> {
  showErrors: boolean;
  /** 提交以外也要亮错误的入口（become-hub 的地址预检）。 */
  revealErrors: () => void;
  submitting: boolean;
  submitError: string | null;
  result: T | null;
  waiter: RestartWaiter;
  handleSubmit: (event: FormEvent) => Promise<void>;
}

export function useHubSetupSubmit<T>({
  client,
  hasErrors,
  submit,
  successMessage,
  onRestarted,
}: HubSetupSubmitOptions<T>): HubSetupSubmitHandle<T> {
  const { t } = useTranslation();
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
    setShowErrors(true);
    if (hasErrors) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submit();
      setResult(outcome.result);
      toast.success(successMessage);
      waiter.start(outcome.previousStartedAt);
    } catch (error) {
      const message = describeSetupError(t, error);
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
    handleSubmit,
  };
}
