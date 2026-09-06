// 设备管理页。页面主体是一个分组列表：分组只有一层，里面放整个 node；node 下的设备永远跟着
// 节点走，只能在节点内排序。没被放进任何分组的 node 按老顺序（self 在前、其余按名）排在根层末尾。
// standalone / mesh 列表还没回来时根层只有一个 self 条目，直接就是今天的卡片网格（不显示分组头）。
//
// 分组布局只存在 entry 自己的库里，所有 `/api/device-folders/*` 请求都在本页顶层的 runtime
// 上发（见 `devices/use-device-folders.ts`），远端 node 的运行时里不发这类请求。
//
// 宽度 / 内边距只由 `DevicesPageContainer` 一处负责：loading、空态、错误态、就绪态共用，
// 内层面板一律 `w-full`，不再各自套 max-width / padding。

import { useInventoryReadiness } from '@/node/inventory-readiness';
import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@vibeterm/api-client';
import { DeviceManagementActions } from '@vibeterm/panels/device-management';
import { Button } from '@vibeterm/ui/button';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { FolderPlus, Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AddDeviceMenu } from './devices/add-device-menu';
import { useAddDeviceTargets } from './devices/add-device-targets';
import { DeviceFoldersView } from './devices/device-folders-view';
import { pruneDeviceSnapshots } from './devices/device-snapshot-store';
import { DevicesActionsMenu } from './devices/devices-actions-menu';
import { type NodeDeviceGroupEntry, toNodeDeviceGroups } from './devices/node-device-group';
import { useDevicesPageCommands } from './devices/page-commands';
import { PendingNodeGroups } from './devices/pending-node-groups';

/** standalone（以及 mesh 列表还没回来时）唯一的那个分组：本机自己。 */
function selfGroup(name: string): NodeDeviceGroupEntry {
  return {
    id: SELF_NODE_ID,
    runtimeNodeId: SELF_NODE_ID,
    name,
    online: true,
    loggedIn: true,
    isSelf: true,
    isHub: false,
    version: null,
    inventory: null,
  };
}

export function DevicesPageContainer({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="devices-page-container"
      className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-3 px-4 py-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:gap-4 sm:px-6 sm:py-5 xl:max-w-7xl"
    >
      {children}
    </div>
  );
}

function DevicesBody({
  meshEnabled,
  entryNodeId,
}: {
  meshEnabled: boolean;
  entryNodeId: string | null;
}) {
  const { t } = useTranslation();
  // standalone 下一个 `/api/mesh/*` 请求都不发
  const { nodes, pendingMembers } = useMeshNodes({ enabled: meshEnabled });
  const readiness = useInventoryReadiness();
  const meshGroups = useMemo(
    () => (meshEnabled ? toNodeDeviceGroups(nodes, entryNodeId) : []),
    [meshEnabled, nodes, entryNodeId]
  );
  const selfName = t('device.addTo.self');
  const groups = useMemo(
    () => (meshGroups.length > 0 ? meshGroups : [selfGroup(selfName)]),
    [meshGroups, selfName]
  );

  // 节点列表**到齐**后才清掉已不在 mesh 里的节点的离线快照（standalone 只留 self）：
  // 一份还在同步中的列表里缺的正是那些节点，照着它清会把它们的快照一并抹掉。
  const { ready } = readiness;
  useEffect(() => {
    if (meshEnabled && !ready) return;
    pruneDeviceSnapshots(groups.map((group) => group.runtimeNodeId));
  }, [meshEnabled, ready, groups]);

  // 成员还没到齐时本机那一组照常渲染（它的设备是真实的），但要挂上分组头并把缺的节点
  // 摆成骨架：否则一份「成功但不完整」的列表会被画成「本机是唯一成员」。
  return (
    <>
      <DeviceFoldersView
        groups={groups}
        showNodeHeaders={meshGroups.length > 0 || readiness.loading}
      />
      {readiness.loading && <PendingNodeGroups pendingMembers={pendingMembers} />}
    </>
  );
}

export default function DevicesPage() {
  const { loaded, meshEnabled, entryNodeId } = useSharedAuthMode();

  return (
    <DevicesPageContainer>
      {loaded ? (
        <DevicesBody meshEnabled={meshEnabled} entryNodeId={entryNodeId} />
      ) : (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        </div>
      )}
    </DevicesPageContainer>
  );
}

// Page title component
export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('sidebar.manageDevices')}</>;
}

// Page actions component
//
// 「新建分组」由页面主体登记入口（两棵子树，见 devices/page-commands.ts），没挂载就不显示；
// 「恢复默认布局」收进「更多」菜单，同样只在登记过命令时可点。全页唯一的「+」：只要登记过
// ready 节点就恒定展开下拉（「添加远程节点」与各节点目标都在里面，单节点也不再走快捷路径）；
// 一个都没登记（standalone / 单面板）时退回派发全局事件，与旧行为一致。
//
// 「更多」里的文件传输 / 端口映射自带节点列表，与页面主体无关，因此恒定可见。
export function PageActions() {
  const { t } = useTranslation();
  const targets = useAddDeviceTargets();
  const commands = useDevicesPageCommands();

  return (
    <div className="flex items-center gap-0.5">
      {commands && (
        <IconTooltip label={t('devices.folders.newFolder')}>
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="devices-new-folder"
            aria-label={t('devices.folders.newFolder')}
            onClick={commands.newFolder}
          >
            <FolderPlus className="h-4 w-4" />
          </Button>
        </IconTooltip>
      )}
      {targets.length > 0 ? <AddDeviceMenu targets={targets} /> : <DeviceManagementActions />}
      <DevicesActionsMenu onResetLayout={commands?.resetLayout} layoutBusy={commands?.layoutBusy} />
    </div>
  );
}
