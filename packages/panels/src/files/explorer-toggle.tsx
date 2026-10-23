// 文件侧栏头部的「展开 / 收起文件管理器」开关：主区正在展示文件管理器即为展开；
// 收起 = 回到进入文件管理器之前停留的主区路由。

import { EXPLORER_ROUTE } from '@vibeterm/stores';
import { getLastMainRoute, isExplorerPath } from '@vibeterm/stores/main-route';
import { useRuntime } from '@vibeterm/stores/react';
import { Button } from '@vibeterm/ui/button';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

export function ExplorerToggleButton() {
  const { t } = useTranslation();
  // 只在本按钮内订阅路由：避免每次导航都重渲整个文件侧栏
  const expanded = isExplorerPath(useLocation().pathname);
  const { host } = useRuntime();
  const label = expanded ? t('files.explorer.hide') : t('files.explorer.show');
  const Icon = expanded ? PanelRightClose : PanelRightOpen;
  // 宿主导航压栈并顺带收起手机端侧栏抽屉；记住的是完整位置（含 search / hash），原样回去
  const toggle = () =>
    host.navigate(expanded ? getLastMainRoute() : EXPLORER_ROUTE, { replace: false });

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={toggle}
      title={label}
      aria-label={label}
      data-testid="files-explorer-toggle"
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}
