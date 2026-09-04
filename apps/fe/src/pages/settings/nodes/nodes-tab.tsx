// 设置页「节点」标签：按运行模式分派。
//
// 本机卡按「连接 → 中继服务 → 网络」三段摆开：standalone 下「连接」段就是四条路径的设置向导，
// mesh 下是当前 Hub / 中继链路与对应的操作。standalone 另加 HTTPS 区块，mesh 再加节点管理。
// 与站点设置表单完全无关：角色 / 直连 / TLS 都是运行态与安装态，不走 `/api/settings/site`。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import type { SetupRelayRole } from '@tmex/api-client/local/types';
import { Reveal } from '@tmex/ui/motion';
import { Skeleton } from '@tmex/ui/skeleton';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HttpsSection } from './https/https-section';
import { LocalMachineCard } from './local-machine-card';
import { NodesManagement } from './management/nodes-management';
import { type SetupIntent, type SetupIntentRecord, takeSetupIntent } from './membership/intent';
import { takeSelfRelayFollowUp } from './setup/self-relay-followup';
import { SetupTransitionProvider } from './setup/setup-transition';
import { useLocalUplinkController } from './uplink/local-uplink-controller';
import { useLocalStatus } from './use-local-status';

export interface SetupIntentRouting {
  /** 向导要预选的路径；四条路径都住在同一个向导里。 */
  wizardPath: SetupIntent | null;
  /** 「本机作为中继」表单的预选角色。 */
  relayRole: SetupRelayRole;
}

/** 把跨重启记号翻成「预选哪条路径、中继表单预选哪个角色」。 */
export function routeSetupIntent(intent: SetupIntentRecord | null): SetupIntentRouting {
  return {
    wizardPath: intent?.path ?? null,
    relayRole: (intent?.path === 'become-relay' ? intent.role : null) ?? 'relay,node',
  };
}

export function NodesTab() {
  const { mode, loaded } = useSharedAuthMode();
  const local = useLocalStatus();
  const [intent, setIntent] = useState<SetupIntentRecord | null>(null);
  const [selfRelayFollowUp, setSelfRelayFollowUp] = useState(false);
  const standalone = mode?.mode !== 'mesh';
  // 上级链路的唯一 owner：本机卡与节点管理页共用同一份 hub 集合 / 中继链路 / 凭据对话框。
  const uplink = useLocalUplinkController({ mode });

  // 退出 mesh 会重启网关并整页刷新回到本页：按退出前记下的意图直接展开对应向导。
  // 记号读一次就清掉，用户再刷新一次不该又被劫持到同一条路径。
  useEffect(() => {
    if (!loaded || !standalone) return;
    const stored = takeSetupIntent();
    if (stored) setIntent(stored);
  }, [loaded, standalone]);

  // 中继兼节点刚设置完：重启后回到本页，把「接入本机中继」顶到眼前。
  useEffect(() => {
    if (!loaded || standalone) return;
    if (takeSelfRelayFollowUp()) setSelfRelayFollowUp(true);
  }, [loaded, standalone]);

  const routing = routeSetupIntent(intent);

  // `/api/auth/mode` 要读 TLS 与证书，慢起来是几百毫秒起步：先按真实版式摆骨架，
  // 别让整页空着转圈。模式相关的区块一律等模式落定再挂（见下方 standalone 分支）。
  if (!loaded) return <NodesTabSkeleton />;

  return (
    // 设置路径与角色菜单共享一份「已提交」状态：后端只放行一条，界面必须同步锁上。
    <SetupTransitionProvider>
      <div className="flex w-full flex-col gap-4" data-testid="settings-nodes-tab">
        {/* 三块区域按阅读顺序错开入场；延迟档位手写在这里，列表短到不需要 <Stagger>。 */}
        <Reveal>
          <LocalMachineCard
            mode={mode}
            status={local.status}
            loading={local.loading}
            loginRequired={local.loginRequired}
            error={local.error}
            uplink={uplink}
            onRefresh={local.refresh}
            wizardPath={routing.wizardPath}
            wizardRelayRole={routing.relayRole}
            selfRelayFollowUp={selfRelayFollowUp}
          />
        </Reveal>

        {/* HTTPS 是安装态，与角色无关：standalone 下做 hub 需要一个 https 公开地址，多给一行提示。 */}
        {standalone ? (
          <Reveal delayMs={60}>
            <HttpsSection showHubUrlHint />
          </Reveal>
        ) : (
          <>
            {/* 纯 node 不需要自己的 HTTPS：外部访问走 hub。
              角色没读到之前**不能**先把区块摆出来——`status` 为 null 时 `role === 'node'` 也是 false，
              纯 node 会在这段时间里拿到一份可操作的 HTTPS 表单（TLS 查询还可能先于角色返回）。 */}
            {local.status ? (
              <Reveal delayMs={60}>
                <HttpsSection disabled={local.status.role === 'node'} />
              </Reveal>
            ) : local.loginRequired ? null : (
              <div
                className="flex h-9 items-center px-1 text-muted-foreground"
                data-testid="https-section-pending"
              >
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              </div>
            )}
            {mode && (
              <Reveal delayMs={120}>
                <NodesManagement mode={mode} uplink={uplink} />
              </Reveal>
            )}
          </>
        )}
      </div>
    </SetupTransitionProvider>
  );
}

function NodesTabSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-nodes-tab-skeleton">
      {/* 三块的高度按本机区块 / HTTPS / 节点管理的实际版式取整，切换过去不至于跳一大截 */}
      <Skeleton className="h-44 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
