// 新增节点 / 待确认区块：直接铺在「节点管理」卡片里，自己不再画边框与标题，
// 展开与否由卡头的「添加」按钮（父组件的 `open`）决定。
//
// `enroll_sk` 只存在于浏览器与 join 串里；join 串只显示这一次，
// admit / 过期后立刻从 DOM 里消失。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { type PendingEnrollment, joinCommand } from '@/node/enrollment';
import type { EnrollmentEngineState } from '@/node/enrollment-engine-state';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CopyableCode } from '../copy-feedback';
import { AdmitRows } from './admit-rows';
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
  onResendKey,
  twoStep,
  engine,
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
  /** 「补发成员密钥」：节点已加入、成员密钥没下发成功的那一条。 */
  onResendKey: (enrollmentId: string) => void;
  /** 确认加入要签两条记录（中继模式）：passkey 用户在确认按钮旁看到「需验证两次」。 */
  twoStep: boolean;
  /** 引擎状态：行的忙碌 / 失败 / 进度从这里读；`clearedIds` 里的 join 串必须立刻从 DOM 里消失。 */
  engine: EnrollmentEngineState;
  /** 本机卡已经在轮询的那份中继快照：给了就不再自己订一份。 */
  relay?: UseMeshRelayResult;
}) {
  const { t } = useTranslation();
  const create = useCreateEnrollment({
    api,
    mode,
    prompt,
    clearedIds: engine.clearedIds,
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

      <AdmitRows
        pendings={pendings}
        engine={engine}
        writable={writable}
        blockedHint={blockedHint}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onResendKey={onResendKey}
        passkeyTwice={{ twoStep, passkeysAvailable: prompt.passkeys.length > 0 }}
      />
    </>
  );
}
