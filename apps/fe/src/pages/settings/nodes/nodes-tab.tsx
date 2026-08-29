// 设置页「节点」标签：按运行模式分派。
//
// standalone → HTTPS 区块 + 开启 hub 向导（做 hub / 加入 hub）；mesh → 本机区块 + HTTPS 区块 + 完整节点管理。
// 与站点设置表单完全无关：角色 / 直连 / TLS 都是运行态与安装态，不走 `/api/settings/site`。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HttpsSection } from './https/https-section';
import { LocalMachineCard } from './local-machine-card';
import { NodesManagement } from './management/nodes-management';
import { type SetupIntent, takeSetupIntent } from './membership/intent';
import { HubSetupWizard } from './setup/hub-setup-wizard';
import { useLocalStatus } from './use-local-status';

export function NodesTab() {
  const { mode, loaded } = useSharedAuthMode();
  const local = useLocalStatus();
  const [wizardPath, setWizardPath] = useState<SetupIntent | null>(null);
  const wizardRef = useRef<HTMLDivElement | null>(null);
  const standalone = mode?.mode !== 'mesh';

  // 退出 mesh 会重启网关并整页刷新回到本页：按退出前记下的意图直接展开对应向导。
  // 记号读一次就清掉，用户再刷新一次不该又被劫持到同一条路径。
  useEffect(() => {
    if (!loaded || !standalone) return;
    const intent = takeSetupIntent();
    if (intent) setWizardPath(intent);
  }, [loaded, standalone]);

  // 角色选择器在页面上半部分，选完要把下面的向导带进视野，否则看着像什么都没发生。
  useEffect(() => {
    if (wizardPath) wizardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [wizardPath]);

  if (!loaded) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-nodes-tab">
      <LocalMachineCard
        mode={mode}
        status={local.status}
        loading={local.loading}
        loginRequired={local.loginRequired}
        onRefresh={local.refresh}
        onSelectSetupPath={setWizardPath}
      />

      {/* HTTPS 是安装态，与角色无关：standalone 摆在向导前面（做 hub 需要一个 https 公开地址），
          mesh 下摆在本机区块后面。 */}
      {standalone ? (
        <>
          <HttpsSection showHubUrlHint />
          {/* `initialPath` 只在首次挂载时生效，改路径必须换 key 重新挂一次。 */}
          <div ref={wizardRef}>
            <HubSetupWizard
              key={wizardPath ?? 'default'}
              localStatus={local.status}
              initialPath={wizardPath}
            />
          </div>
        </>
      ) : (
        <>
          {/* 纯 node 不需要自己的 HTTPS：外部访问走 hub。 */}
          <HttpsSection disabled={local.status?.role === 'node'} />
          {mode && <NodesManagement mode={mode} />}
        </>
      )}
    </div>
  );
}
