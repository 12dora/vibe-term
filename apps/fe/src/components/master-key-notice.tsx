// 主密钥失配的常驻提示。
//
// `VIBETERM_MASTER_KEY` 解不开节点身份时网关照样起得来：HTTP、前端、本机密码登录全都在，
// 只有 mesh 与 Hub 被整段停掉（见 `packages/app/src/runtime/assemble.ts`）。界面上的表现是
// 「节点全没了」而不是任何一条报错——不把真正的原因摆到眼前，运维只会去查网络。
//
// 判据取 `/healthz.degraded`：它是匿名接口，登录页（此时还没有会话）也读得到。
// 提示不可关闭：恢复须改 env 并重启网关，在那之前每一次刷新都应当再看到它。

import { CopyableCode } from '@/pages/settings/nodes/copy-feedback';
import { cn } from '@vibeterm/ui';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const MASTER_KEY_MISMATCH = 'master_key_mismatch';

/** 恢复不了原密钥时重建节点身份，在**本节点**执行；账户凭据保留，须重新加入 Hub。 */
export const MESH_RESET_IDENTITY_COMMAND = 'vibeterm mesh reset-identity';

/** `/healthz` 的复查间隔。恢复必然伴随一次重启，慢一点无所谓，只要别一直挂着旧结论。 */
export const HEALTH_POLL_MS = 60_000;

/** `/healthz` 的降级标记；字段缺失（旧网关）或空串一律按「没有降级」处理。 */
export function readDegraded(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { degraded?: unknown }).degraded;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 读一次 `/healthz`。
 *
 * 任何失败都返回 `null`：网关正在重启、反代抖了一下都会走到这里，把它当成「降级」
 * 会在每次重启时弹一条与事实无关的严重提示。
 */
export async function fetchDegraded(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/healthz', { cache: 'no-store' });
    if (!res.ok) return null;
    return readDegraded(await res.json());
  } catch {
    return null;
  }
}

export interface UseGatewayDegradedOptions {
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

/** `/healthz.degraded` 的轮询绑定；组件卸载后不再 setState。 */
export function useGatewayDegraded(options: UseGatewayDegradedOptions = {}): string | null {
  const fetchImpl = options.fetchImpl;
  const pollIntervalMs = options.pollIntervalMs ?? HEALTH_POLL_MS;
  const [degraded, setDegraded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void fetchDegraded(fetchImpl ?? fetch).then((value) => {
        if (!cancelled) setDegraded(value);
      });
    };
    read();
    const timer = setInterval(read, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchImpl, pollIntervalMs]);

  return degraded;
}

/**
 * 提示本体（不自带请求）。
 *
 * 单独导出是为了让静态渲染测得到：自带 effect 的那个壳在 `renderToStaticMarkup` 下
 * 永远是空的。
 */
export function MasterKeyMismatchNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive',
        className
      )}
      data-testid="master-key-mismatch"
    >
      <span className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 font-medium">{t('app.masterKeyMismatch.title')}</span>
      </span>
      <CopyableCode
        label={t('app.masterKeyMismatch.commandLabel')}
        value={MESH_RESET_IDENTITY_COMMAND}
        testId="master-key-reset-identity"
      />
    </div>
  );
}

/** 挂在登录页与节点页顶部的自取版本：只有 `master_key_mismatch` 这一档才出现。 */
export function MasterKeyNotice({
  className,
  ...options
}: UseGatewayDegradedOptions & { className?: string }) {
  const degraded = useGatewayDegraded(options);
  if (degraded !== MASTER_KEY_MISMATCH) return null;
  return <MasterKeyMismatchNotice className={className} />;
}
