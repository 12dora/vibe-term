// Hub 主备切换的三个对话框。
//
// 主确认框把整个计划摊开：每一步一行，外加「原主不可达」「之后没有可写 Hub」这类警示——
// 切换会重启目标机并短暂中断管理面，点之前必须知道要发生什么。
//
// 第二个只在 `admit-hub` 被旧节点挡住时出现：列出挡路的节点，勾了「仍然继续」才补强制头重发，
// 因为强推之后这些节点再也同步不到新的 key log 记录。
//
// 第三个是「原主已降备、目标没升起来」的恢复框：这一刻集群没有可写 Hub，一条会自己消失的
// toast 顶不住，必须留一个用户不做选择就不走的框——重试目标，或回滚回原主。

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
import { Checkbox } from '@tmex/ui/checkbox';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  HubRoleForcePrompt,
  HubRoleRecoveryPrompt,
  HubRoleSwitchController,
  HubRoleSwitchPlan,
} from './use-hub-role-switch';
import { hubRoleSteps, hubRoleWarnings } from './use-hub-role-switch';

/** 对话框正文。单独导出：AlertDialog 走 portal，静态渲染只看得到这一块。 */
export function HubRoleDialogBody({ plan }: { plan: HubRoleSwitchPlan }) {
  const { t } = useTranslation();
  const steps = hubRoleSteps(t, plan);
  const warnings = hubRoleWarnings(t, plan);
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="nodes-hub-role-body">
      <ol className="flex list-decimal flex-col gap-0.5 pl-4 text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {warnings.map((warning) => (
        <p
          key={warning}
          className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2 text-destructive"
          data-testid="nodes-hub-role-warning"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  );
}

export function HubRoleForceBody({ force }: { force: HubRoleForcePrompt }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="nodes-hub-role-force-body">
      <p className="text-muted-foreground">
        {t('nodes.hubs.role.forceText', { minVersion: force.minVersion })}
      </p>
      <ul className="flex flex-col gap-0.5">
        {force.nodes.map((node) => (
          <li key={node.id} className="truncate" data-testid={`nodes-hub-role-old-${node.id}`}>
            {node.name}｜{node.version ?? '—'}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HubRoleForceDialog({
  force,
  onResolve,
}: { force: HubRoleForcePrompt; onResolve: (accepted: boolean) => void }) {
  const { t } = useTranslation();
  const [accepted, setAccepted] = useState(false);
  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) onResolve(false);
      }}
    >
      <AlertDialogContent data-testid="nodes-hub-role-force-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.hubs.role.forceTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('nodes.hubs.role.forceDescription')}</AlertDialogDescription>
        </AlertDialogHeader>

        <HubRoleForceBody force={force} />

        <label className="flex items-center gap-2 text-xs" htmlFor="nodes-hub-role-force-accept">
          <Checkbox
            id="nodes-hub-role-force-accept"
            checked={accepted}
            onCheckedChange={(next) => setAccepted(next === true)}
            data-testid="nodes-hub-role-force-accept"
          />
          {t('nodes.hubs.role.forceAccept')}
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => onResolve(false)}
            data-testid="nodes-hub-role-force-cancel"
          >
            {t('nodes.hubs.role.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!accepted}
            onClick={() => onResolve(true)}
            data-testid="nodes-hub-role-force-confirm"
          >
            {t('nodes.hubs.role.forceConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 恢复框正文：说清楚集群此刻的处境，再把后端给的失败原因原样摆出来。 */
export function HubRoleRecoveryBody({ recovery }: { recovery: HubRoleRecoveryPrompt }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="nodes-hub-role-recovery-body">
      <p className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2 text-destructive">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        {t('nodes.hubs.role.recovery.noWriter', {
          target: recovery.targetName,
          from: recovery.fromName,
        })}
      </p>
      <p className="text-muted-foreground">{recovery.message}</p>
    </div>
  );
}

function HubRoleRecoveryDialog({
  recovery,
  onResolve,
}: {
  recovery: HubRoleRecoveryPrompt;
  onResolve: HubRoleSwitchController['resolveRecovery'];
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open>
      <AlertDialogContent data-testid="nodes-hub-role-recovery-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.hubs.role.recovery.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('nodes.hubs.role.recovery.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <HubRoleRecoveryBody recovery={recovery} />

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => onResolve('dismiss')}
            data-testid="nodes-hub-role-recovery-dismiss"
          >
            {t('nodes.hubs.role.recovery.dismiss')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            onClick={() => onResolve('rollback')}
            data-testid="nodes-hub-role-recovery-rollback"
          >
            {t('nodes.hubs.role.recovery.rollback')}
          </AlertDialogAction>
          <AlertDialogAction
            onClick={() => onResolve('retry')}
            data-testid="nodes-hub-role-recovery-retry"
          >
            {t('nodes.hubs.role.recovery.retry')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function HubRoleDialog({ roleSwitch }: { roleSwitch: HubRoleSwitchController }) {
  const { t } = useTranslation();
  const { plan, force, recovery } = roleSwitch;

  if (force) return <HubRoleForceDialog force={force} onResolve={roleSwitch.resolveForce} />;
  // 恢复框压过待确认的计划：没有 writer 的时候先把这一件事处理掉。
  if (recovery) {
    return <HubRoleRecoveryDialog recovery={recovery} onResolve={roleSwitch.resolveRecovery} />;
  }
  if (!plan) return null;

  const title = t(
    plan.intent === 'promote' ? 'nodes.hubs.role.confirmPromote' : 'nodes.hubs.role.confirmDemote'
  );
  const description = plan.target
    ? t('nodes.hubs.role.confirmText', { target: plan.target.name })
    : t('nodes.hubs.role.confirmTextNoWriter', { from: plan.origin.name });

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) roleSwitch.dismiss();
      }}
    >
      <AlertDialogContent data-testid="nodes-hub-role-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <HubRoleDialogBody plan={plan} />

        <AlertDialogFooter>
          <AlertDialogCancel onClick={roleSwitch.dismiss} data-testid="nodes-hub-role-cancel">
            {t('nodes.hubs.role.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={roleSwitch.confirm} data-testid="nodes-hub-role-confirm">
            {t('nodes.hubs.role.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
