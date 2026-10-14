// 「访问令牌」的数据层：列表、创建、撤销，都打本机（entry）的 `/api/auth/tokens`。

import { type ApiClient, defaultApiClient, isApiErrorCode } from '@vibeterm/api-client';
import {
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from '@vibeterm/api-client/auth/index';
import type {
  AccessTokenDto,
  CreateAccessTokenRequest,
  CreateAccessTokenResponse,
} from '@vibeterm/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tokenErrorText } from './access-token-format';

export interface AccessTokensState {
  tokens: AccessTokenDto[] | null;
  loadError: string | null;
  revokingId: string | null;
  revokeError: string | null;
  create: (body: CreateAccessTokenRequest) => Promise<CreateAccessTokenResponse>;
  revoke: (id: string) => Promise<void>;
}

export function useAccessTokens(client: ApiClient = defaultApiClient): AccessTokensState {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<AccessTokenDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const runRef = useRef(0);

  const load = useCallback(() => {
    const run = ++runRef.current;
    const controller = new AbortController();
    listAccessTokens(client, controller.signal)
      .then((res) => {
        if (run !== runRef.current) return;
        setTokens(res.tokens);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (run !== runRef.current || controller.signal.aborted) return;
        setLoadError(tokenErrorText(t, err));
      });
    return () => controller.abort();
  }, [client, t]);

  useEffect(() => load(), [load]);

  const create = useCallback(
    async (body: CreateAccessTokenRequest) => {
      const res = await createAccessToken(client, body);
      const rest = (prev: AccessTokenDto[] | null) =>
        (prev ?? []).filter((item) => item.id !== res.token.id);
      setTokens((prev) => [res.token, ...rest(prev)]);
      return res;
    },
    [client]
  );

  const revoke = useCallback(
    async (id: string) => {
      setRevokeError(null);
      setRevokingId(id);
      const drop = () => setTokens((prev) => prev?.filter((item) => item.id !== id) ?? prev);
      try {
        await revokeAccessToken(client, id);
        drop();
      } catch (err) {
        // 已经不在了（别处撤销 / 过期清理）与撤销成功是同一个结果。
        if (isApiErrorCode(err, 'not_found')) drop();
        else setRevokeError(tokenErrorText(t, err));
      } finally {
        setRevokingId(null);
      }
    },
    [client, t]
  );

  return { tokens, loadError, revokingId, revokeError, create, revoke };
}
