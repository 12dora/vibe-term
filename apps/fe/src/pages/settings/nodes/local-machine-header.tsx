// 本机卡的卡头：标题、角色徽标、**唯一那枚**状态徽标，以及右侧的操作菜单。
//
// standalone 下没有角色徽标也没有菜单：那台机器的下一步全在下面的设置向导里，
// 在卡头再摆一份角色选择只会和向导抢同一件事。

import { SIDE_PANEL_LINK_STATE, useSidePanel } from '@/components/side-panels/use-side-panel';
import type { LocalRole } from '@tmex/api-client/local/types';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { CardTitle } from '@tmex/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Ellipsis } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type MachineStatusBadge, roleMenuTargets } from './machine-status';
import { ROLE_LABEL_KEY, isMeshRole } from './membership/role-transition';

const STATUS_VARIANT: Record<MachineStatusBadge['tone'], 'default' | 'destructive' | 'outline'> = {
  ok: 'default',
  warn: 'destructive',
  muted: 'outline',
};

export interface LocalMachineHeaderProps {
  /** `/api/local/status` 还没回来 / 失败时为 `null`：角色徽标与操作菜单一律不出。 */
  role: LocalRole | null;
  status: MachineStatusBadge;
  /** mesh 下才有角色徽标与操作菜单。 */
  meshEnabled: boolean;
  /** 退出 / 设置提交在途：角色相关的菜单项一律锁上。 */
  roleLocked: boolean;
  onSelectRole: (role: LocalRole) => void;
  onLeave: () => void;
}

export function LocalMachineHeader({
  role,
  status,
  meshEnabled,
  roleLocked,
  onSelectRole,
  onLeave,
}: LocalMachineHeaderProps) {
  const { t } = useTranslation();
  // 账号安全改成右侧滑出面板，链接只换查询串，留在当前页面。
  const { hrefFor: panelHref } = useSidePanel();
  // 菜单里每一项都要先知道当前角色才算得出目标；角色未知（状态没回来）或不可操作
  // （纯中继没有网页、standalone 的下一步在向导里）时整个菜单不挂——摆一个点了没反应的菜单
  // 比没有菜单更糟。
  const menuRole = meshEnabled && role && isMeshRole(role) ? role : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <CardTitle className="mr-auto flex min-w-0 flex-wrap items-center gap-2">
        {t('nodes.machine.title')}
        {meshEnabled && role && (
          <Badge
            variant="secondary"
            title={t('nodes.machine.role')}
            data-testid="local-machine-role"
          >
            {t(ROLE_LABEL_KEY[role])}
          </Badge>
        )}
        <Badge
          variant={STATUS_VARIANT[status.tone]}
          data-testid="local-machine-status"
          data-status-state={status.state}
        >
          {t(status.key, status.params)}
        </Badge>
      </CardTitle>
      {menuRole && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('nodes.machine.menu.label')}
                title={t('nodes.machine.menu.label')}
                data-testid="local-machine-menu"
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <LocalMachineMenuList
              roles={roleMenuTargets(menuRole)}
              roleLabel={(target) => t(ROLE_LABEL_KEY[target])}
              labels={{
                changeRole: t('nodes.machine.menu.changeRole'),
                leave: t('nodes.machine.menu.leave'),
                security: t('nodes.machine.accountSecurity'),
              }}
              securityHref={panelHref('security')}
              roleLocked={roleLocked}
              onSelectRole={onSelectRole}
              onLeave={onLeave}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * 菜单内容。单独导出且**不带 hook**：Base UI 的菜单走 portal，静态渲染什么都不输出，
 * 单测只能把它当普通函数调用再对元素树断言（与 `BulkActionsMenuList` 同一套做法）。
 */
export function LocalMachineMenuList({
  roles,
  roleLabel,
  labels,
  securityHref,
  roleLocked,
  onSelectRole,
  onLeave,
}: {
  roles: LocalRole[];
  roleLabel: (role: LocalRole) => string;
  labels: { changeRole: string; leave: string; security: string };
  securityHref: string;
  roleLocked: boolean;
  onSelectRole: (role: LocalRole) => void;
  onLeave: () => void;
}) {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>{labels.changeRole}</DropdownMenuLabel>
        {roles.map((target) => (
          <DropdownMenuItem
            key={target}
            disabled={roleLocked}
            onClick={() => onSelectRole(target)}
            data-testid={`local-machine-role-${target}`}
          >
            {roleLabel(target)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={roleLocked}
        onClick={onLeave}
        data-testid="local-machine-leave"
      >
        {labels.leave}
      </DropdownMenuItem>
      <DropdownMenuItem
        data-testid="local-machine-account-security"
        render={<Link to={securityHref} state={SIDE_PANEL_LINK_STATE} />}
      >
        {labels.security}
      </DropdownMenuItem>
    </>
  );
}
