// 新增节点 / 待确认区块：直接铺在「节点管理」卡片里，自己不再画边框与标题，
// 展开与否由卡头的「添加」按钮（父组件的 `open`）决定。
//
// `enroll_sk` 只存在于浏览器与 join 串里，**不经过 hub**；join 串只显示这一次，
// admit / 过期后立刻从 DOM 里消失。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { type PendingEnrollment, joinCommand } from '@/node/enrollment';
import type { HubApi } from '@/node/hub-api';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CopyableCode } from '../copy-feedback';
import type { ResolvedMode } from './types';
import { useCreateEnrollment } from './use-create-enrollment';

export { resolveHubPublicUrl } from './use-create-enrollment';

export function EnrollmentSection({
  api,
  mode,
  hubApi,
  writable,
  blockedHint,
  writerPublicUrl,
  open,
  prompt,
  pendings,
  onConfirm,
  onCancel,
  busyIds,
  hubUnconfirmedIds,
  clearedIds,
}: {
  api: AuthApi;
  mode: ResolvedMode;
  hubApi: HubApi | null;
  /** 上级链路当前接受管理写入（hub 在线且可写，或已挂上中继）。 */
  writable: boolean;
  /** 不可写时的原因文案。 */
  blockedHint: string;
  /** writer hub 的对外地址；拒写提示靠它指路。 */
  writerPublicUrl: string | null;
  /** 卡头「添加」按钮控制的展开态。 */
  open: boolean;
  prompt: CredentialPromptHandle;
  pendings: PendingEnrollment[];
  onConfirm: (pending: PendingEnrollment) => void;
  /** 取消一条待确认记录（误点「添加」的回退路径）：仅删本地 pending，hub 侧记录会自然过期。 */
  onCancel: (pending: PendingEnrollment) => void;
  /** 正在跑 admit 的 pending id：确认与取消都要禁用——取消一条 append 未定的记录会丢字节。 */
  busyIds: string[];
  hubUnconfirmedIds: string[];
  /** 已 admit / 已过期的 pending id：对应的 join 串必须立刻从 DOM 里消失。 */
  clearedIds: string[];
}) {
  const { t } = useTranslation();
  const create = useCreateEnrollment({ api, mode, hubApi, prompt, clearedIds, writerPublicUrl });
  const { created, hubUrl } = create;

  return (
    <>
      {open && (
        <div
          className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
          data-testid="nodes-enroll-form"
        >
          <Input
            placeholder={t('nodes.enrollment.nameLabel')}
            value={create.name}
            data-testid="nodes-enroll-name"
            onChange={(event) => create.setName(event.target.value)}
          />
          {create.error && <p className="text-xs text-destructive">{create.error}</p>}
          <div>
            <Button
              type="button"
              disabled={create.busy || !writable}
              title={writable ? undefined : blockedHint}
              onClick={() => void create.submit()}
              data-testid="nodes-enroll-submit"
            >
              {create.busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
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
            const busy = busyIds.includes(id);
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
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    disabled={busy || !writable}
                    title={writable ? undefined : blockedHint}
                    onClick={() => onConfirm(pending)}
                    data-testid={`nodes-pending-confirm-${id}`}
                  >
                    {busy ? <Loader2 className="animate-spin" /> : <Check />}
                    {unconfirmed
                      ? t('nodes.enrollment.retryHub')
                      : t('nodes.enrollment.confirmPending')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => onCancel(pending)}
                    data-testid={`nodes-pending-cancel-${id}`}
                  >
                    <X />
                    {t('nodes.enrollment.cancelPending')}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
