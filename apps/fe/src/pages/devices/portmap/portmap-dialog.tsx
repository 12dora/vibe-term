// 端口映射弹窗：上方新建表单，下方是所有在线已登录节点上的映射汇总（打开期间 2 秒轮询）。

import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { ConfirmDialog } from '@tmex/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { firstUsableNode, toDialogNodeOptions } from '../dialog-nodes';
import { usePendingExportCleanups } from './pending-cleanup';
import { PendingCleanupList } from './pending-cleanup-list';
import { PortMapCreateForm } from './portmap-create-form';
import {
  type PortMapFormState,
  createPortMapFormState,
  resetFormIfUnchanged,
} from './portmap-form-state';
import { PortMapTable } from './portmap-table';
import { type PortMapRow, usePortMapList } from './use-portmap-list';
import { usePortMapMutations } from './use-portmap-mutations';

export interface PortMapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function PortMapDialog({ open, onOpenChange }: PortMapDialogProps) {
  const { t } = useTranslation();
  const { meshEnabled, entryNodeId } = useSharedAuthMode();
  const { nodes } = useMeshNodes({ enabled: meshEnabled });
  const selfName = t('device.addTo.self');

  const options = useMemo(
    () => toDialogNodeOptions(nodes, entryNodeId, selfName),
    [nodes, entryNodeId, selfName]
  );

  const [form, setForm] = useState<PortMapFormState>(() => createPortMapFormState(null));
  const [pendingDelete, setPendingDelete] = useState<PortMapRow | null>(null);

  const list = usePortMapList(open, options);
  const mutations = usePortMapMutations(options, list.refetch);
  const cleanups = usePendingExportCleanups();

  // 监听节点缺省落到第一个可用节点；目标节点让用户自己选（多数场景是「本机 → 某台远端」）。
  const formState =
    form.listenNodeId === null ? { ...form, listenNodeId: firstUsableNode(options) } : form;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="devices-portmap-dialog"
        className="flex max-h-[calc(100dvh-2rem)] w-full flex-col sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>{t('devices.portmap.title')}</DialogTitle>
          <DialogDescription>{t('devices.portmap.description')}</DialogDescription>
        </DialogHeader>

        <div className="-mr-2 flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-2">
          <PortMapCreateForm
            state={formState}
            setState={setForm}
            options={options}
            submitting={mutations.submitting}
            errorKey={mutations.errorKey}
            onSubmit={() => {
              const submitted = form;
              mutations.create(formState, (listenNodeId) =>
                setForm(resetFormIfUnchanged(submitted, listenNodeId))
              );
            }}
          />

          <PendingCleanupList
            records={cleanups}
            options={options}
            busyId={mutations.busyId}
            onRetry={mutations.retryCleanup}
          />

          {list.rows.length === 0 ? (
            <p
              className="py-6 text-center text-xs text-muted-foreground"
              data-testid="portmap-empty"
            >
              {t(list.failed ? 'devices.portmap.loadFailed' : 'devices.portmap.empty')}
            </p>
          ) : (
            <PortMapTable
              rows={list.rows}
              options={options}
              busyId={mutations.busyId}
              onToggle={mutations.toggle}
              onDelete={setPendingDelete}
            />
          )}
        </div>

        <ConfirmDialog
          open={pendingDelete !== null}
          testId="portmap-delete-confirm"
          confirmTestId="portmap-delete-confirm-ok"
          media={<Trash2 className="h-5 w-5" />}
          title={t('devices.portmap.deleteConfirmTitle')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('devices.portmap.delete')}
          onCancel={() => setPendingDelete(null)}
          onOpenChange={(next) => {
            if (!next) setPendingDelete(null);
          }}
          onConfirm={() => {
            if (pendingDelete) mutations.remove(pendingDelete);
            setPendingDelete(null);
          }}
        >
          {t('devices.portmap.deleteConfirmDescription', {
            name: pendingDelete?.name || `${pendingDelete?.listenPort ?? ''}`,
          })}
        </ConfirmDialog>
      </DialogContent>
    </Dialog>
  );
}
