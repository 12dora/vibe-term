// 设置页「节点」标签：按运行模式分派。
//
// standalone → HTTPS 区块 + 开启 hub 向导（做 hub / 加入 hub）；mesh → 本机区块 + HTTPS 区块 + 完整节点管理。
// 与站点设置表单完全无关：角色 / 直连 / TLS 都是运行态与安装态，不走 `/api/settings/site`。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { NodesManagement } from '@/pages/nodes/nodes-management';
import { Loader2 } from 'lucide-react';
import { HttpsSection } from './https/https-section';
import { LocalMachineCard } from './local-machine-card';
import { HubSetupWizard } from './setup/hub-setup-wizard';
import { useLocalStatus } from './use-local-status';

export function NodesTab() {
  const { mode, loaded } = useSharedAuthMode();
  const local = useLocalStatus();

  if (!loaded) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  const standalone = mode?.mode !== 'mesh';

  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-nodes-tab">
      <LocalMachineCard
        mode={mode}
        status={local.status}
        loading={local.loading}
        loginRequired={local.loginRequired}
        onRefresh={local.refresh}
      />

      {/* HTTPS 是安装态，与角色无关：standalone 摆在向导前面（做 hub 需要一个 https 公开地址），
          mesh 下摆在本机区块后面。 */}
      {standalone ? (
        <>
          <HttpsSection showHubUrlHint />
          <HubSetupWizard localStatus={local.status} />
        </>
      ) : (
        <>
          <HttpsSection />
          {mode && <NodesManagement mode={mode} compact showAccountSecurityLink={false} />}
        </>
      )}
    </div>
  );
}
