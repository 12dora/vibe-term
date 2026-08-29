// 新增节点 / 待确认区块：直接铺在「节点管理」卡片里，自己不再画边框与标题，
// 展开与否由卡头的「添加」按钮（父组件的 `open`）决定。
//
// `enroll_sk` 只存在于浏览器与 join 串里，**不经过 hub**；join 串只显示这一次，
// admit / 过期后立刻从 DOM 里消失。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { headFromResponse } from '@/auth/key-log-actions';
import {
  type CreatedEnrollment,
  type PendingEnrollment,
  createEnrollmentOnHub,
  isTrustedHubUrl,
  joinCommand,
  requireRootPublicKey,
} from '@/node/enrollment';
import type { HubApi } from '@/node/hub-api';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Check, Copy, Loader2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedMode } from './types';

export function EnrollmentSection({
  api,
  mode,
  hubApi,
  hubOnline,
  open,
  prompt,
  pendings,
  onConfirm,
  busyPendingId,
  hubUnconfirmedIds,
  clearedIds,
}: {
  api: AuthApi;
  mode: ResolvedMode;
  hubApi: HubApi | null;
  hubOnline: boolean;
  /** 卡头「添加」按钮控制的展开态。 */
  open: boolean;
  prompt: CredentialPromptHandle;
  pendings: PendingEnrollment[];
  onConfirm: (pending: PendingEnrollment) => void;
  busyPendingId: string | null;
  hubUnconfirmedIds: string[];
  /** 已 admit / 已过期的 pending id：对应的 join 串必须立刻从 DOM 里消失。 */
  clearedIds: string[];
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // join 串只在内存里、只显示这一次；admit / 过期后立即清掉。
  const [created, setCreated] = useState<CreatedEnrollment | null>(null);

  useEffect(() => {
    if (created && clearedIds.includes(created.pending.hubEnrollmentId)) setCreated(null);
  }, [clearedIds, created]);

  const hubUrl = resolveHubPublicUrl(created, mode);

  const submit = useCallback(async () => {
    setError(null);
    if (!hubApi) {
      setError(t('nodes.hubOffline'));
      return;
    }
    setBusy(true);
    try {
      const rootEpoch = requireRootEpoch(mode);
      // 根公钥来自服务端：passkey 签授权时浏览器手里根本没有根钥，join 串第二段只能靠它。
      const rootPublicKey = requireRootPublicKey(mode);
      // 设计 §2 步骤 3：这次交互进 5 分钟窗口，随后的 admit-node 自动复用，不再打扰用户。
      const signer = await prompt.request({ purpose: 'enroll' });
      if (!signer) return;
      const head = await api.keyLogHead();
      const outcome = await createEnrollmentOnHub({
        hubApi,
        uid: mode.uid,
        rootEpoch,
        signer,
        rootPublicKey,
        keyLogHeadHash: headFromResponse(head).hash,
        name,
      });
      setCreated(outcome);
      setName('');
    } catch (err) {
      // 走到这里说明 enrollment 没建成（多半是 hub 请求失败）：复用窗口里的根钥没有任何
      // 后续动作会用到，立刻清零，不要等 5 分钟定时器（见 F4-fix 评审 Major「所有权式清零」）。
      prompt.forget();
      const code = (err as { code?: string })?.code;
      setError(
        code
          ? t(`auth.errors.${code}`, { defaultValue: code })
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      setBusy(false);
    }
  }, [api, hubApi, mode, name, prompt, t]);

  return (
    <>
      {open && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
          data-testid="nodes-enroll-form"
        >
          <Input
            placeholder={t('nodes.enrollment.nameLabel')}
            value={name}
            data-testid="nodes-enroll-name"
            onChange={(event) => setName(event.target.value)}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div>
            <Button
              type="button"
              disabled={busy || !hubOnline}
              onClick={() => void submit()}
              data-testid="nodes-enroll-submit"
            >
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {t('nodes.enrollment.create')}
            </Button>
          </div>
        </div>
      )}

      {created &&
        (hubUrl ? (
          <div
            className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2"
            data-testid="nodes-join-info"
          >
            <p className="text-xs text-muted-foreground">{t('nodes.enrollment.joinHint')}</p>
            <CopyableCode
              label={t('nodes.enrollment.joinCommand')}
              value={joinCommand(hubUrl, created.joinToken, created.pending.name)}
              testId="nodes-join-command"
            />
            <CopyableCode
              label={t('nodes.enrollment.joinToken')}
              value={created.joinToken}
              testId="nodes-join-token"
            />
          </div>
        ) : (
          // hub 没给出对外地址就不能编 join 命令：用入口 origin 会把新设备指到没有
          // HubRuntime 的机器，redeem 直接 404（见 F4-3 评审 Blocker）。
          <p className="text-xs text-destructive" data-testid="nodes-join-no-url">
            {t('nodes.enrollment.missingHubUrl')}
          </p>
        ))}

      {pendings.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="nodes-pending-list">
          {pendings.map((pending) => {
            const id = pending.hubEnrollmentId;
            const unconfirmed = hubUnconfirmedIds.includes(id);
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs"
                data-testid={`nodes-pending-${id}`}
              >
                <span className="truncate">
                  {unconfirmed
                    ? t('nodes.enrollment.hubNotConfirmed')
                    : t('nodes.enrollment.pending')}
                  <span className="ml-2 font-mono text-muted-foreground">
                    {pending.name ?? pending.enrollPk.slice(0, 12)}
                  </span>
                </span>
                <Button
                  type="button"
                  size="xs"
                  disabled={busyPendingId === id}
                  onClick={() => onConfirm(pending)}
                  data-testid={`nodes-pending-confirm-${id}`}
                >
                  {busyPendingId === id ? <Loader2 className="animate-spin" /> : <Check />}
                  {unconfirmed
                    ? t('nodes.enrollment.retryHub')
                    : t('nodes.enrollment.confirmPending')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * join 命令里的 hub 地址：**只**来自 hub —— enrollment 创建响应的 `public_url`，
 * 或 `/api/auth/mode` 的 `hubPublicUrl`。两者都没有、或值不是可信 https URL 就不生成命令：
 * 它会被原样拼进一条让用户粘贴执行的 shell 命令，畸形值等于命令注入（见 F4-fix 评审 Major）。
 */
export function resolveHubPublicUrl(
  created: { hubPublicUrl: string | null } | null,
  mode: { hubPublicUrl?: string | null }
): string | null {
  const url = created?.hubPublicUrl ?? mode.hubPublicUrl ?? null;
  return isTrustedHubUrl(url) ? url : null;
}

export function CopyableCode({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-start gap-1">
        <code
          className="min-w-0 flex-1 break-all rounded bg-background p-2 text-[11px]"
          data-testid={testId}
        >
          {value}
        </code>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={copy}
          data-testid={`${testId}-copy`}
        >
          {copied ? <Check className="tmex-scale-in" /> : <Copy className="tmex-scale-in" />}
          <span aria-live="polite">
            {copied ? t('nodes.actions.copied') : t('nodes.actions.copy')}
          </span>
        </Button>
      </div>
    </div>
  );
}
