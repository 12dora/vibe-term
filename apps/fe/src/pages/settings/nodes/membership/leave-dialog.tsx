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
import { type MeshRole, ROLE_LABEL_KEY } from './role-transition';
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

const TITLE_KEY: Record<LeaveDialogKind, string> = {
  leave: 'nodes.membership.leaveConfirm.title',
  switch: 'nodes.membership.switchConfirm.title',
  'change-hub': 'nodes.membership.changeHubConfirm.title',
};

// 后果按角色分：纯 node 关心「旧 hub 上那条记录怎么办」，hub 兼节点关心「下级节点会掉线」。
// 混着讲的话，对 hub 来说是纯粹的谎话（本机就是 hub，没有别的 hub 留记录）。
const CONSEQUENCES_KEY: Record<MeshRole, string> = {
  node: 'nodes.membership.consequencesNode',
  'hub,node': 'nodes.membership.consequencesHub',
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
  // `leave` 已经成功、只是没等到网关回来：破坏性动作**不能**再放出来重放一遍，
  // 只给「刷新」与「再查一次」两个恢复出口。
  const stranded = phase === 'timeout';

  return (
    <AlertDialog
      open={phase !== 'confirming'}
      onOpenChange={(next) => {
        if (!next && !busy && !done && !stranded) onCancel();
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
            <span className="mt-2 block">{t(CONSEQUENCES_KEY[request.from])}</span>
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
          {stranded ? (
            <>
              {/* `AlertDialogAction` 只是个按钮（不会关闭对话框），「再查一次」正好留在原地继续等。 */}
              <AlertDialogAction
                variant="outline"
                onClick={leave.recheck}
                data-testid="membership-leave-recheck"
              >
                {t('nodes.membership.checkAgain')}
              </AlertDialogAction>
              <AlertDialogAction onClick={leave.reload} data-testid="membership-leave-reload">
                {t('nodes.membership.reload')}
              </AlertDialogAction>
            </>
          ) : (
            <>
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
            </>
          )}
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
        <p className="font-mono">tmex restart</p>
      </div>
    );
  }

  const label =
    phase === 'confirming'
      ? t('nodes.membership.confirming')
      : phase === 'leaving'
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
