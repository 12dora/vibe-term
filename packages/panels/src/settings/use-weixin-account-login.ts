import { useQueryClient } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import type {
  ListWeixinAccountUsersResponse,
  StartWeixinLoginResponse,
  WeixinLoginStatusResponse,
} from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  WEIXIN_LOGIN_POLL_INTERVAL_MS,
  type WeixinLoginPhase,
  type WeixinUserBaseline,
  buildUserBaseline,
  classifyWeixinLoginStatus,
  findFreshUser,
  weixinLoginEndpoints,
} from './weixin-login-flow';

export interface UseWeixinAccountLoginOptions {
  open: boolean;
  accountId: string;
  onOpenChange: (open: boolean) => void;
}

export interface WeixinAccountLoginState {
  qrcodeUrl: string | null;
  phase: WeixinLoginPhase;
  statusMessage: string | null;
  restart: () => void;
}

export function useWeixinAccountLogin({
  open,
  accountId,
  onOpenChange,
}: UseWeixinAccountLoginOptions): WeixinAccountLoginState {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();

  const [qrcodeUrl, setQrcodeUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<WeixinLoginPhase>('starting');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 每次登录尝试递增的代际：迟到的 fetch resolve / 排程一律按代际丢弃。
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const endpoints = useMemo(() => weixinLoginEndpoints(accountId), [accountId]);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // 失效当前登录尝试：清定时器、中止在途 fetch、推进代际（关闭/切换/重启时调用）。
  const cancelActive = useCallback(() => {
    clearPollTimer();
    abortRef.current?.abort();
    abortRef.current = null;
    genRef.current += 1;
  }, [clearPollTimer]);

  const schedule = useCallback((run: () => void) => {
    pollTimerRef.current = setTimeout(run, WEIXIN_LOGIN_POLL_INTERVAL_MS);
  }, []);

  const failWith = useCallback(
    (err: unknown, gen: number, signal: AbortSignal) => {
      if (signal.aborted || genRef.current !== gen) return;
      setPhase('error');
      setStatusMessage(err instanceof Error ? err.message : t('weixin.loginFailed'));
    },
    [t]
  );

  // 先按代际丢弃迟到响应，再校验 HTTP 状态；false / null 表示本次尝试已失效，调用方直接返回。
  const requestOk = useCallback(
    async (path: string, gen: number, init: RequestInit, fallback: string): Promise<boolean> => {
      const res = await apiClient.fetch(path, init);
      if (genRef.current !== gen) return false;
      if (!res.ok) throw new Error(await parseApiError(res, fallback));
      return true;
    },
    [apiClient]
  );

  const requestJson = useCallback(
    async <T>(
      path: string,
      gen: number,
      init: RequestInit,
      fallback: string
    ): Promise<T | null> => {
      const res = await apiClient.fetch(path, init);
      if (genRef.current !== gen) return null;
      if (!res.ok) throw new Error(await parseApiError(res, fallback));
      const data = (await res.json()) as T;
      return genRef.current === gen ? data : null;
    },
    [apiClient]
  );

  const finishBinding = useCallback(async () => {
    cancelActive();
    await queryClient.invalidateQueries({ queryKey: ['weixin-accounts'] });
    toast.success(t('weixin.bindSuccess'));
    onOpenChange(false);
  }, [cancelActive, onOpenChange, queryClient, t]);

  // 第二段轮询：扫码确认后等用户发新消息，检测到后自动 approve 并完成绑定。
  const pollBinding = useCallback(
    async (gen: number, signal: AbortSignal, baseline: WeixinUserBaseline) => {
      try {
        const data = await requestJson<ListWeixinAccountUsersResponse>(
          endpoints.users,
          gen,
          { signal },
          t('weixin.loginFailed')
        );
        if (!data) return;

        const fresh = findFreshUser(data.users, baseline);
        if (!fresh) {
          schedule(() => void pollBinding(gen, signal, baseline));
          return;
        }

        setPhase('binding');
        setStatusMessage(t('weixin.bindingInProgress'));
        if (fresh.status === 'pending') {
          const approved = await requestOk(
            endpoints.approve(fresh.userId),
            gen,
            { method: 'POST', signal },
            t('weixin.approveFailed')
          );
          if (!approved) return;
        }
        await finishBinding();
      } catch (err) {
        failWith(err, gen, signal);
      }
    },
    [endpoints, failWith, finishBinding, requestJson, requestOk, schedule, t]
  );

  // 第一段轮询：等扫码确认。确认后拍 users baseline 快照，转入第二段。
  const pollLogin = useCallback(
    async (gen: number, signal: AbortSignal) => {
      try {
        const data = await requestJson<WeixinLoginStatusResponse>(
          endpoints.status,
          gen,
          { signal },
          t('weixin.loginFailed')
        );
        if (!data) return;

        const classified = classifyWeixinLoginStatus(data);
        if (classified.kind === 'expired') {
          setPhase('expired');
          setStatusMessage(t('weixin.loginExpired'));
          return;
        }
        if (classified.kind === 'error') {
          setPhase('error');
          setStatusMessage(t('weixin.loginError', { message: classified.message }));
          return;
        }
        if (classified.kind === 'pending') {
          setPhase('scanning');
          setStatusMessage(t('weixin.scanQrcodeHint'));
          schedule(() => void pollLogin(gen, signal));
          return;
        }

        const usersData = await requestJson<ListWeixinAccountUsersResponse>(
          endpoints.users,
          gen,
          { signal },
          t('weixin.loginFailed')
        );
        if (!usersData) return;

        setPhase('awaitMessage');
        setStatusMessage(t('weixin.scanConfirmedSendHint'));
        schedule(() => void pollBinding(gen, signal, buildUserBaseline(usersData.users)));
      } catch (err) {
        failWith(err, gen, signal);
      }
    },
    [endpoints, failWith, pollBinding, requestJson, schedule, t]
  );

  const start = useCallback(async () => {
    cancelActive();
    const gen = genRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('starting');
    setStatusMessage(null);
    setQrcodeUrl(null);
    try {
      const data = await requestJson<StartWeixinLoginResponse>(
        endpoints.start,
        gen,
        { method: 'POST', signal: controller.signal },
        t('weixin.loginFailed')
      );
      if (!data) return;
      // qrcodeUrl 是二维码要编码的 URL（iLink 的 qrcode_img_content 实为 URL，非图片），前端生成二维码。
      setQrcodeUrl(data.qrcodeUrl);
      setPhase('scanning');
      setStatusMessage(t('weixin.scanQrcodeHint'));
      schedule(() => void pollLogin(gen, controller.signal));
    } catch (err) {
      failWith(err, gen, controller.signal);
    }
  }, [cancelActive, endpoints, failWith, pollLogin, requestJson, schedule, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在弹窗打开或账号切换时重新发起登录，start/cancelActive 为稳定回调
  useEffect(() => {
    if (!open) {
      cancelActive();
      return;
    }
    void start();
    return cancelActive;
  }, [open, accountId]);

  const restart = useCallback(() => void start(), [start]);

  return { qrcodeUrl, phase, statusMessage, restart };
}
