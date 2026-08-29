// 设备管理页。页面主体是一棵文件夹树：文件夹里可以放整个 node 分组，也可以放单台设备；
// 没被放进任何文件夹的 node 按老顺序（self 在前、其余按名）排在根层末尾。
// standalone / mesh 列表还没回来时根层只有一个 self 条目，直接就是今天的卡片网格（不显示分组头）。
//
// 文件夹布局只存在 entry 自己的库里，所有 `/api/device-folders/*` 请求都在本页顶层的 runtime
// 上发（见 `devices/use-device-folders.ts`），远端 node 的运行时里不发这类请求。

import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@tmex/api-client';
import { DeviceManagementActions } from '@tmex/panels/device-management';
import { Button } from '@tmex/ui/button';
import { FolderPlus, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AddDeviceMenu } from './devices/add-device-menu';
import { useAddDeviceTargets } from './devices/add-device-targets';
import { DeviceFoldersView } from './devices/device-folders-view';
import { useNewFolderRequest } from './devices/new-folder-request';
import { type NodeDeviceGroupEntry, toNodeDeviceGroups } from './devices/node-device-group';

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

function DevicesBody({
  meshEnabled,
  entryNodeId,
}: {
  meshEnabled: boolean;
  entryNodeId: string | null;
}) {
  const { t } = useTranslation();
  // standalone 下一个 `/api/mesh/*` 请求都不发
  const { nodes } = useMeshNodes({ enabled: meshEnabled });
  const meshGroups = useMemo(
    () => (meshEnabled ? toNodeDeviceGroups(nodes, entryNodeId) : []),
    [meshEnabled, nodes, entryNodeId]
  );
  const selfName = t('device.addTo.self');
  const groups = useMemo(
    () => (meshGroups.length > 0 ? meshGroups : [selfGroup(selfName)]),
    [meshGroups, selfName]
  );

  return <DeviceFoldersView groups={groups} showNodeHeaders={meshGroups.length > 0} />;
}

export default function DevicesPage() {
  const { loaded, meshEnabled, entryNodeId } = useSharedAuthMode();

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }
  return <DevicesBody meshEnabled={meshEnabled} entryNodeId={entryNodeId} />;
}

// Page title component
export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('sidebar.manageDevices')}</>;
}

// Page actions component
//
// 「新建文件夹」由页面主体登记入口（两棵子树，见 devices/new-folder-request.ts），没挂载就不显示。
// 全页唯一的「+」：多个 ready 节点先选目标，单个直接开该节点的对话框；
// 一个都没登记（standalone / 单面板）时退回派发全局事件，与旧行为一致。
export function PageActions() {
  const { t } = useTranslation();
  const targets = useAddDeviceTargets();
  const newFolder = useNewFolderRequest();

  return (
    <div className="flex items-center gap-0.5">
      {newFolder && (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="devices-new-folder"
          aria-label={t('devices.folders.newFolder')}
          title={t('devices.folders.newFolder')}
          onClick={newFolder}
        >
          <FolderPlus className="h-4 w-4" />
        </Button>
      )}
      {targets.length > 1 ? (
        <AddDeviceMenu targets={targets} />
      ) : (
        <DeviceManagementActions onAddDevice={targets[0]?.open} />
      )}
    </div>
  );
}
