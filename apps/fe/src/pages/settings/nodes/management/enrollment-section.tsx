// 新增节点 / 待确认区块：直接铺在「节点管理」卡片里，自己不再画边框与标题，
// 展开与否由卡头的「添加」按钮（父组件的 `open`）决定。
//
// `enroll_sk` 只存在于浏览器与 join 串里；join 串只显示这一次，
// admit / 过期后立刻从 DOM 里消失。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { type PendingEnrollment, joinCommand } from '@/node/enrollment';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CopyableCode } from '../copy-feedback';
import type { ResolvedMode } from './types';
import { useCreateEnrollment } from './use-create-enrollment';

export { resolvePublicUrl } from './use-create-enrollment';

export function EnrollmentSection({
  api,
  mode,
  writable,
  blockedHint,
  open,
  prompt,
  pendings,
  onConfirm,
  onCancel,
  busyIds,
  unconfirmedIds,
  clearedIds,
  relay,
}: {
  api: AuthApi;
  mode: ResolvedMode;
  /** 上级链路当前接受管理写入（已挂上中继）。 */
  writable: boolean;
  /** 不可写时的原因文案。 */
  blockedHint: string;
  /** 卡头「添加」按钮控制的展开态。 */
  open: boolean;
  prompt: CredentialPromptHandle;
  pendings: PendingEnrollment[];
  onConfirm: (pending: PendingEnrollment) => void;
  /** 取消一条待确认记录（误点「添加」的回退路径）：仅删本地 pending，中继侧记录会自然过期。 */
  onCancel: (pending: PendingEnrollment) => void;
  /** 正在跑 admit 的 pending id：确认与取消都要禁用——取消一条 append 未定的记录会丢字节。 */
  busyIds: string[];
  /** `hubAck === false` 或分类失败：手上还留着一份可重发记录的 pending id。`relayAck` 走 toast。 */
  unconfirmedIds: string[];
  /** 已 admit / 已过期的 pending id：对应的 join 串必须立刻从 DOM 里消失。 */
  clearedIds: string[];
  /** 本机卡已经在轮询的那份中继快照：给了就不再自己订一份。 */
  relay?: UseMeshRelayResult;
}) {
  const { t } = useTranslation();
  const create = useCreateEnrollment({
    api,
    mode,
    prompt,
    clearedIds,
    ...(relay ? { relay } : {}),
  });
  const { created, publicUrl } = create;

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
        (publicUrl ? (
          <div
            className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2"
            data-testid="nodes-join-info"
          >
            <p className="text-xs text-muted-foreground">{t('nodes.enrollment.joinHint')}</p>
            <CopyableCode
              label={t('nodes.enrollment.joinCommand')}
              value={joinCommand(publicUrl, created.joinToken, created.pending.name)}
              testId="nodes-join-command"
            />
            <CopyableCode
              label={t('nodes.enrollment.joinToken')}
              value={created.joinToken}
              testId="nodes-join-token"
            />
          </div>
        ) : (
          // 上级没给出对外地址就不能编 join 命令：用入口 origin 会把新设备指到没有
          // 中继 enrollment 路由的机器，redeem 直接 404（见 F4-3 评审 Blocker）。
          <p className="text-xs text-destructive" data-testid="nodes-join-no-url">
            {t('nodes.enrollment.missingRelayUrl')}
          </p>
        ))}

      {pendings.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="nodes-pending-list">
          {pendings.map((pending) => (
            <PendingRow
              key={pending.hubEnrollmentId}
              pending={pending}
              unconfirmed={unconfirmedIds.includes(pending.hubEnrollmentId)}
              busy={busyIds.includes(pending.hubEnrollmentId)}
              writable={writable}
              blockedHint={blockedHint}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** 一条待确认记录。上级未确认时文案与按钮都换成「重试」口径。 */
function PendingRow({
  pending,
  unconfirmed,
  busy,
  writable,
  blockedHint,
  onConfirm,
  onCancel,
}: {
  pending: PendingEnrollment;
  unconfirmed: boolean;
  busy: boolean;
  writable: boolean;
  blockedHint: string;
  onConfirm: (pending: PendingEnrollment) => void;
  onCancel: (pending: PendingEnrollment) => void;
}) {
  const { t } = useTranslation();
  const id = pending.hubEnrollmentId;
  return (
    <li
      className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs"
      data-testid={`nodes-pending-${id}`}
    >
      <span className="truncate">
        {unconfirmed ? t('nodes.enrollment.relayNotConfirmed') : t('nodes.enrollment.pending')}
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
          {unconfirmed ? t('nodes.enrollment.retry') : t('nodes.enrollment.confirmPending')}
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
}
