// 退出 mesh / 换 hub 的确认与进度对话框。
//
// 这是本页最具破坏性的动作：本机的账号、node 身份、缓存的 peer 会被一次性删掉，并且重启后
// 当前会话立刻失效。因此确认文案必须把后果讲全，进度也留在同一个对话框里——退出期间
// 页面其它部分已经没有意义了。

import type { LocalRole } from '@tmex/api-client/local/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SetupIntent } from './intent';
import type { MeshRole } from './role-transition';
import type { LeaveMesh } from './use-leave-mesh';

export type LeaveDialogKind = 'leave' | 'switch' | 'change-hub';

export interface LeaveDialogRequest {
  kind: LeaveDialogKind;
  from: MeshRole;
  /** 目标角色，用于「切换到 X」的文案。 */
  target: LocalRole;
  /** 重启后要展开的向导路径；纯粹退出为 null。 */
  intent: SetupIntent | null;
}

const ROLE_LABEL_KEY: Record<LocalRole, string> = {
  standalone: 'nodes.machine.roleStandalone',
  node: 'nodes.machine.roleNode',
  'hub,node': 'nodes.machine.roleHub',
};

const TITLE_KEY: Record<LeaveDialogKind, string> = {
  leave: 'nodes.membership.leaveConfirm.title',
  switch: 'nodes.membership.switchConfirm.title',
  'change-hub': 'nodes.membership.changeHubConfirm.title',
};

export function LeaveDialog({
  request,
  leave,
  onConfirm,
  onCancel,
}: {
  request: LeaveDialogRequest | null;
  leave: LeaveMesh;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!request) return null;
  const { phase, busy, error, warning } = leave;
  const done = phase === 'restarted';

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next && !busy && !done) onCancel();
      }}
    >
      <AlertDialogContent data-testid="membership-leave-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(TITLE_KEY[request.kind])}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">
              {request.kind === 'switch'
                ? t('nodes.membership.switchConfirm.description', {
                    role: t(ROLE_LABEL_KEY[request.target]),
                  })
                : t(`nodes.membership.${camel(request.kind)}Confirm.description`)}
            </span>
            <span className="mt-2 block">{t('nodes.membership.consequences')}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {warning && (
          <p
            className="tmex-fade rounded-lg bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400"
            data-testid="membership-leave-warning"
          >
            {warning}
          </p>
        )}
        {error && (
          <p
            className="tmex-fade rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
            data-testid="membership-leave-error"
          >
            {error}
          </p>
        )}
        <LeaveProgress leave={leave} />

        <AlertDialogFooter>
          {!busy && !done && (
            <AlertDialogCancel onClick={onCancel} data-testid="membership-leave-cancel">
              {t('nodes.membership.cancel')}
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            variant="destructive"
            disabled={busy || done}
            onClick={onConfirm}
            data-testid="membership-leave-confirm"
          >
            {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('nodes.membership.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LeaveProgress({ leave }: { leave: LeaveMesh }) {
  const { t } = useTranslation();
  const { phase, elapsedMs } = leave;
  if (phase === 'idle' || phase === 'error') return null;

  if (phase === 'timeout') {
    return (
      <div
        className="tmex-fade space-y-1 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400"
        data-testid="membership-leave-restart-timeout"
      >
        <p>{t('nodes.membership.restartTimeout')}</p>
        <p className="font-mono">npx tmex-cli restart</p>
      </div>
    );
  }

  const label =
    phase === 'leaving'
      ? t('nodes.membership.leaving')
      : phase === 'restarting'
        ? t('nodes.membership.restarting', { seconds: Math.round(elapsedMs / 1000) })
        : t('nodes.membership.restarted');

  return (
    // 每个阶段换一次 key：进度文案切换时重放一次淡入，比原地换字更好读。
    <p
      key={phase}
      className="tmex-fade flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
      data-testid={`membership-leave-${phase}`}
    >
      {phase !== 'restarted' && (
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      )}
      {label}
    </p>
  );
}

function camel(kind: LeaveDialogKind): string {
  return kind === 'change-hub' ? 'changeHub' : kind;
}
