// 中继管理页的两个「更多」菜单：页头（运营者动作）与租户卡（默认配额）。
//
// 下拉内容单独导出且不自带 hook：Base UI 的菜单走 portal，静态渲染什么都不输出，
// 单测只能直接对元素树断言（与 `BulkActionsMenuList` 同一套做法）。

import { Button } from '@tmex/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Ellipsis, KeyRound, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function MoreMenu({
  testId,
  children,
}: {
  testId: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('relay.admin.more')}
            title={t('relay.admin.more')}
            data-testid={testId}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 文案由调用方传进来：菜单内容不带 hook，单测才能当普通函数调用再对元素树断言。 */
export function RelayAdminMenuList({
  label,
  onChangePassword,
}: { label: string; onChangePassword: () => void }) {
  return (
    <DropdownMenuItem onClick={onChangePassword} data-testid="relay-password-change">
      <KeyRound className="size-4" />
      {label}
    </DropdownMenuItem>
  );
}

/** 页头「更多」：中继本身的运营动作。 */
export function RelayAdminMenu({ onChangePassword }: { onChangePassword: () => void }) {
  const { t } = useTranslation();
  return (
    <MoreMenu testId="relay-admin-menu">
      <RelayAdminMenuList
        label={t('relay.admin.password.change')}
        onChangePassword={onChangePassword}
      />
    </MoreMenu>
  );
}

export function TenantsMenuList({
  label,
  onDefaultQuota,
}: { label: string; onDefaultQuota: () => void }) {
  return (
    <DropdownMenuItem onClick={onDefaultQuota} data-testid="relay-default-quota-open">
      <SlidersHorizontal className="size-4" />
      {label}
    </DropdownMenuItem>
  );
}

/** 租户卡「更多」：作用于全体租户的设置。 */
export function TenantsMenu({ onDefaultQuota }: { onDefaultQuota: () => void }) {
  const { t } = useTranslation();
  return (
    <MoreMenu testId="relay-tenants-menu">
      <TenantsMenuList label={t('relay.admin.quota.menuItem')} onDefaultQuota={onDefaultQuota} />
    </MoreMenu>
  );
}
