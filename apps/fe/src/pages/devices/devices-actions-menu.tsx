// 设备页顶栏的「更多」：文件传输、端口映射、恢复默认布局。
//
// 两个弹窗自带节点列表，与页面主体无关，所以菜单项恒定可见；「恢复默认布局」要页面主体
// 登记过命令才可点（两棵子树，见 `page-commands.ts`）。
//
// 下拉内容不带 hook 单独导出：Base UI 的菜单走 portal，静态渲染什么都不输出，
// 单测只能对元素树做结构断言。

import { lazyChunk } from '@/lazy-chunk';
import { Button } from '@tmex/ui/button';
import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { ArrowLeftRight, Ellipsis, Network, RotateCcw } from 'lucide-react';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

const TransferDialog = lazyChunk(() => import('./transfer/transfer-dialog').then((m) => m.default));
const PortMapDialog = lazyChunk(() => import('./portmap/portmap-dialog').then((m) => m.default));

export interface DevicesActionsMenuListProps {
  transferLabel: string;
  portmapLabel: string;
  resetLabel: string;
  resetDisabled: boolean;
  onTransfer: () => void;
  onPortmap: () => void;
  onReset: () => void;
}

export function DevicesActionsMenuList({
  transferLabel,
  portmapLabel,
  resetLabel,
  resetDisabled,
  onTransfer,
  onPortmap,
  onReset,
}: DevicesActionsMenuListProps) {
  return (
    <>
      <DropdownMenuItem
        data-testid="devices-open-transfer"
        title={transferLabel}
        onClick={onTransfer}
      >
        <ArrowLeftRight className="h-4 w-4" />
        <span className="min-w-0 truncate">{transferLabel}</span>
      </DropdownMenuItem>
      <DropdownMenuItem data-testid="devices-open-portmap" title={portmapLabel} onClick={onPortmap}>
        <Network className="h-4 w-4" />
        <span className="min-w-0 truncate">{portmapLabel}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="devices-reset-layout"
        title={resetLabel}
        disabled={resetDisabled}
        onClick={onReset}
      >
        <RotateCcw className="h-4 w-4" />
        <span className="min-w-0 truncate">{resetLabel}</span>
      </DropdownMenuItem>
    </>
  );
}

export interface DevicesActionsMenuProps {
  /** 页面主体登记的「恢复默认布局」；未登记时该项禁用。 */
  onResetLayout?: () => void;
  layoutBusy?: boolean;
}

export function DevicesActionsMenu({ onResetLayout, layoutBusy }: DevicesActionsMenuProps) {
  const { t } = useTranslation();
  const [transferOpen, setTransferOpen] = useState(false);
  const [portmapOpen, setPortmapOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="devices-more"
              aria-label={t('devices.menu.more')}
              title={t('devices.menu.more')}
            />
          }
        >
          <Ellipsis className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DevicesActionsMenuList
            transferLabel={t('devices.menu.fileTransfer')}
            portmapLabel={t('devices.menu.portMap')}
            resetLabel={t('devices.folders.resetLayout')}
            resetDisabled={!onResetLayout || Boolean(layoutBusy)}
            onTransfer={() => setTransferOpen(true)}
            onPortmap={() => setPortmapOpen(true)}
            onReset={() => setConfirmReset(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmReset}
        testId="devices-reset-layout-dialog"
        confirmTestId="devices-reset-layout-confirm"
        media={<RotateCcw className="h-5 w-5" />}
        title={t('devices.folders.resetConfirmTitle')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('devices.folders.resetLayout')}
        onCancel={() => setConfirmReset(false)}
        onOpenChange={(next) => {
          if (!next) setConfirmReset(false);
        }}
        onConfirm={() => {
          setConfirmReset(false);
          onResetLayout?.();
        }}
      >
        {t('devices.folders.resetConfirmDescription')}
      </ConfirmDialog>

      {transferOpen && (
        <Suspense fallback={null}>
          <TransferDialog open={transferOpen} onOpenChange={setTransferOpen} />
        </Suspense>
      )}
      {portmapOpen && (
        <Suspense fallback={null}>
          <PortMapDialog open={portmapOpen} onOpenChange={setPortmapOpen} />
        </Suspense>
      )}
    </>
  );
}
