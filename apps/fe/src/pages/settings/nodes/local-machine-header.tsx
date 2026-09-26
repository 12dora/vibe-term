// 本机卡的卡头：标题、角色徽标、**唯一那枚**状态徽标，以及右侧的操作菜单。
//
// standalone 下没有角色徽标也没有菜单：那台机器的下一步全在下面的设置向导里，
// 在卡头再摆一份角色选择只会和向导抢同一件事。

import { SIDE_PANEL_LINK_STATE, useSidePanel } from '@/components/side-panels/use-side-panel';
import type { LocalRole } from '@vibeterm/api-client/local/types';
import { Badge } from '@vibeterm/ui/badge';
import { Button } from '@vibeterm/ui/button';
import { CardTitle } from '@vibeterm/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vibeterm/ui/dropdown-menu';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { LoginHistoryDialog } from './login-history/login-history-dialog';
import { type MachineStatusBadge, roleMenuTargets } from './machine-status';
import { isMeshRole, roleLabelKey } from './membership/role-transition';
import type { ConnectMenuItem } from './uplink/connect-menu';

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
  /** 「连接」那一组：接中继 / 追加 / 移除 / 离开中继，由卡片按当前形态算好传进来。 */
  connectActions: ConnectMenuItem[];
  onSelectRole: (role: LocalRole) => void;
  onLeave: () => void;
}

export function LocalMachineHeader({
  role,
  status,
  meshEnabled,
  roleLocked,
  connectActions,
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
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    // ⋯ 永远钉在右上角：整行不换行，标题与徽标在左半边自己折。
    <div className="flex min-w-0 items-start gap-2">
      <CardTitle className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {t('nodes.machine.title')}
        {meshEnabled && role && (
          <Badge
            variant="secondary"
            title={t('nodes.machine.role')}
            data-testid="local-machine-role"
          >
            {t(roleLabelKey(role))}
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
                className="ml-auto shrink-0"
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
              roleLabel={(target) => t(roleLabelKey(target))}
              connect={connectActions}
              labels={menuLabels(t)}
              securityHref={panelHref('security')}
              onLoginHistory={() => setHistoryOpen(true)}
              roleLocked={roleLocked}
              onSelectRole={onSelectRole}
              onLeave={onLeave}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {menuRole && <LoginHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} />}
    </div>
  );
}

function menuLabels(t: (key: string) => string): LocalMachineMenuListProps['labels'] {
  return {
    connect: t('nodes.machine.menu.connect'),
    changeRole: t('nodes.machine.menu.changeRole'),
    leave: t('nodes.machine.menu.leave'),
    security: t('nodes.machine.accountSecurity'),
    loginHistory: t('nodes.machine.menu.loginHistory'),
  };
}

export interface LocalMachineMenuListProps {
  roles: LocalRole[];
  roleLabel: (role: LocalRole) => string;
  /** 当前形态下的上级操作；空数组时整组不出。 */
  connect: ConnectMenuItem[];
  labels: {
    connect: string;
    changeRole: string;
    leave: string;
    security: string;
    loginHistory: string;
  };
  securityHref: string;
  roleLocked: boolean;
  onSelectRole: (role: LocalRole) => void;
  onLeave: () => void;
  onLoginHistory: () => void;
}

/**
 * 菜单内容。单独导出且**不带 hook**：Base UI 的菜单走 portal，静态渲染什么都不输出，
 * 单测只能把它当普通函数调用再对元素树断言（与 `BulkActionsMenuList` 同一套做法）。
 */
export function LocalMachineMenuList({
  roles,
  roleLabel,
  connect,
  labels,
  securityHref,
  roleLocked,
  onSelectRole,
  onLeave,
  onLoginHistory,
}: LocalMachineMenuListProps) {
  return (
    <>
      {connect.length > 0 && (
        <>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{labels.connect}</DropdownMenuLabel>
            {connect.map((item) => (
              <DropdownMenuItem
                key={item.key}
                {...(item.destructive ? { variant: 'destructive' as const } : {})}
                disabled={item.disabled === true}
                title={item.reason}
                {...(item.reason ? { 'aria-describedby': `${item.testId}-reason` } : {})}
                onClick={item.onSelect}
                data-testid={item.testId}
              >
                {item.label}
                {/* 读屏拿不到 title：理由再挂一份 sr-only 文本，由 aria-describedby 指过来。 */}
                {item.reason ? (
                  <span id={`${item.testId}-reason`} className="sr-only">
                    {item.reason}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
        </>
      )}
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
      <DropdownMenuItem onClick={onLoginHistory} data-testid="local-machine-login-history">
        {labels.loginHistory}
      </DropdownMenuItem>
    </>
  );
}
