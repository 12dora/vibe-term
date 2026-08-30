// 设备管理页。页面主体是一个分组列表：分组只有一层，里面放整个 node；node 下的设备永远跟着
// 节点走，只能在节点内排序。没被放进任何分组的 node 按老顺序（self 在前、其余按名）排在根层末尾。
// standalone / mesh 列表还没回来时根层只有一个 self 条目，直接就是今天的卡片网格（不显示分组头）。
//
// 分组布局只存在 entry 自己的库里，所有 `/api/device-folders/*` 请求都在本页顶层的 runtime
// 上发（见 `devices/use-device-folders.ts`），远端 node 的运行时里不发这类请求。
//
// 宽度 / 内边距只由 `DevicesPageContainer` 一处负责：loading、空态、错误态、就绪态共用，
// 内层面板一律 `w-full`，不再各自套 max-width / padding。

import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@tmex/api-client';
import { DeviceManagementActions } from '@tmex/panels/device-management';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import { IconTooltip } from '@tmex/ui/icon-tooltip';
import { FolderPlus, Loader2, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AddDeviceMenu } from './devices/add-device-menu';
import { useAddDeviceTargets } from './devices/add-device-targets';
import { DeviceFoldersView } from './devices/device-folders-view';
import { pruneDeviceSnapshots } from './devices/device-snapshot-store';
import { type NodeDeviceGroupEntry, toNodeDeviceGroups } from './devices/node-device-group';
import { useDevicesPageCommands } from './devices/page-commands';

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
  const { nodes, loadedAt } = useMeshNodes({ enabled: meshEnabled });
  const meshGroups = useMemo(
    () => (meshEnabled ? toNodeDeviceGroups(nodes, entryNodeId) : []),
    [meshEnabled, nodes, entryNodeId]
  );
  const selfName = t('device.addTo.self');
  const groups = useMemo(
    () => (meshGroups.length > 0 ? meshGroups : [selfGroup(selfName)]),
    [meshGroups, selfName]
  );

  // 节点列表落定后清掉已不在 mesh 里的节点的离线快照（standalone 只留 self）
  useEffect(() => {
    if (meshEnabled && loadedAt === null) return;
    pruneDeviceSnapshots(groups.map((group) => group.runtimeNodeId));
  }, [meshEnabled, loadedAt, groups]);

  return <DeviceFoldersView groups={groups} showNodeHeaders={meshGroups.length > 0} />;
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

function ResetLayoutButton({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconTooltip label={t('devices.folders.resetLayout')}>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="devices-reset-layout"
          aria-label={t('devices.folders.resetLayout')}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </IconTooltip>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <RotateCcw className="h-5 w-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('devices.folders.resetConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('devices.folders.resetConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="devices-reset-layout-confirm"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {t('devices.folders.resetLayout')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Page actions component
//
// 「新建分组」「恢复默认布局」由页面主体登记入口（两棵子树，见 devices/page-commands.ts），
// 没挂载就不显示。全页唯一的「+」：多个 ready 节点先选目标，单个直接开该节点的对话框；
// 一个都没登记（standalone / 单面板）时退回派发全局事件，与旧行为一致。
export function PageActions() {
  const { t } = useTranslation();
  const targets = useAddDeviceTargets();
  const commands = useDevicesPageCommands();

  return (
    <div className="flex items-center gap-0.5">
      {commands && (
        <>
          <ResetLayoutButton onConfirm={commands.resetLayout} disabled={commands.layoutBusy} />
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
        </>
      )}
      {targets.length > 1 ? (
        <AddDeviceMenu targets={targets} />
      ) : (
        <DeviceManagementActions onAddDevice={targets[0]?.open} />
      )}
    </div>
  );
}
