// Nodes 管理页 `/nodes`（设计 §4「Nodes 管理页」）。
//
// 页面只负责：拉 `/api/auth/mode`、standalone 整页不渲染、把管理主体挂上去。
// 管理主体（数据管线 + enrollment + 节点表 + 凭据对话框）在 `./nodes/nodes-management`，
// 与设置页「节点」标签共用。

import { useAuthMode } from '@/auth/use-session-key';
import type { AuthApi, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NodesManagement } from './nodes/nodes-management';

export interface NodesPageProps {
  mode?: AuthModeResponse;
  api?: AuthApi;
}

export default function NodesPage({ mode: modeOverride, api = defaultAuthApi }: NodesPageProps) {
  const fetched = useAuthMode(api, { enabled: !modeOverride });
  const mode = modeOverride ?? fetched.mode;

  if (!modeOverride && fetched.loading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (!mode || mode.mode === 'none') {
    return null;
  }
  return <NodesManagement mode={mode} api={api} />;
}

export const PageTitle = () => {
  const { t } = useTranslation();
  return <>{t('nodes.title')}</>;
};

/** 供路由表挂载。 */
export const nodesRoute = {
  path: '/nodes',
  moduleLoader: () => import('./NodesPage'),
} as const;
