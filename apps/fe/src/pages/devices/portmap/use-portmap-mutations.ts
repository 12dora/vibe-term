// 四个写操作（创建 / 暂停继续 / 删除 / 重试清理放行）的状态机：谁在飞、错在哪，以及成功后刷新列表。

import { createNodeApiClient, updatePortMap } from '@vibeterm/api-client';
import { useState } from 'react';

import { type DialogNodeOption, findDialogNode } from '../dialog-nodes';
import type { PendingExportCleanup } from './pending-cleanup';
import {
  createPortMapping,
  deletePortMapping,
  portMapErrorKey,
  retryExportCleanup,
} from './portmap-actions';
import { type PortMapFormState, parsePort } from './portmap-form-state';
import type { PortMapRow } from './use-portmap-list';

export interface PortMapMutations {
  submitting: boolean;
  busyId: string | null;
  errorKey: string | null;
  create: (form: PortMapFormState, onCreated: (listenNodeId: string) => void) => void;
  toggle: (row: PortMapRow) => void;
  remove: (row: PortMapRow) => void;
  retryCleanup: (record: PendingExportCleanup) => void;
}

function runtimeIdOf(options: DialogNodeOption[], meshId: string): string | null {
  return options.find((option) => option.meshId === meshId)?.id ?? null;
}

export function usePortMapMutations(
  options: DialogNodeOption[],
  onChanged: () => void
): PortMapMutations {
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const fail = (error: unknown) => setErrorKey(portMapErrorKey(error));

  const create: PortMapMutations['create'] = (form, onCreated) => {
    const listen = findDialogNode(options, form.listenNodeId);
    const target = findDialogNode(options, form.targetNodeId);
    const listenPort = parsePort(form.listenPort);
    const targetPort = parsePort(form.targetPort);
    if (!listen || !target || listenPort === null || targetPort === null) return;

    setSubmitting(true);
    setErrorKey(null);
    void createPortMapping({
      listen: { nodeId: listen.id, meshId: listen.meshId, host: form.listenHost, port: listenPort },
      target: {
        nodeId: target.id,
        meshId: target.meshId,
        host: form.targetHost.trim(),
        port: targetPort,
      },
      name: form.name.trim(),
    })
      .then(() => {
        onCreated(listen.id);
        onChanged();
      })
      .catch(fail)
      .finally(() => setSubmitting(false));
  };

  const toggle: PortMapMutations['toggle'] = (row) => {
    setBusyId(row.id);
    setErrorKey(null);
    void updatePortMap(createNodeApiClient(row.nodeId), row.id, { paused: !row.paused })
      .then(onChanged)
      .catch(fail)
      .finally(() => setBusyId(null));
  };

  const remove: PortMapMutations['remove'] = (row) => {
    setBusyId(row.id);
    setErrorKey(null);
    void deletePortMapping({
      listen: {
        nodeId: row.nodeId,
        meshId: options.find((option) => option.id === row.nodeId)?.meshId ?? row.nodeId,
        host: row.listenHost,
        port: row.listenPort,
      },
      target: {
        nodeId: runtimeIdOf(options, row.targetNodeId),
        meshId: row.targetNodeId,
        host: row.targetHost,
        port: row.targetPort,
      },
      mapId: row.id,
      name: row.name,
    })
      .then(onChanged)
      .catch(fail)
      .finally(() => setBusyId(null));
  };

  const retryCleanup: PortMapMutations['retryCleanup'] = (record) => {
    setBusyId(record.mapId);
    setErrorKey(null);
    void retryExportCleanup({
      record,
      listenNodeId: runtimeIdOf(options, record.listenMeshId),
      targetNodeId: runtimeIdOf(options, record.targetMeshId),
    })
      .then((outcome) => {
        if (outcome === 'pending') setErrorKey('devices.portmap.cleanup.failed');
        else onChanged();
      })
      .catch(fail)
      .finally(() => setBusyId(null));
  };

  return { submitting, busyId, errorKey, create, toggle, remove, retryCleanup };
}
