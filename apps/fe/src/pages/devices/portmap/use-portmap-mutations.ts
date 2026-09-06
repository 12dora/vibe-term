// 三个写操作（创建 / 暂停继续 / 删除）的状态机：谁在飞、错在哪，以及成功后刷新列表。

import { createNodeApiClient, updatePortMap } from '@tmex/api-client';
import { useState } from 'react';

import { type DialogNodeOption, findDialogNode } from '../dialog-nodes';
import { createPortMapping, deletePortMapping, portMapErrorKey } from './portmap-actions';
import { type PortMapFormState, parsePort } from './portmap-form-state';
import type { PortMapRow } from './use-portmap-list';

export interface PortMapMutations {
  submitting: boolean;
  busyId: string | null;
  errorKey: string | null;
  create: (form: PortMapFormState, onCreated: (listenNodeId: string) => void) => void;
  toggle: (row: PortMapRow) => void;
  remove: (row: PortMapRow) => void;
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
      listenNodeId: row.nodeId,
      targetNodeId: options.find((option) => option.meshId === row.targetNodeId)?.id ?? null,
      mapId: row.id,
    })
      .then(onChanged)
      .catch(fail)
      .finally(() => setBusyId(null));
  };

  return { submitting, busyId, errorKey, create, toggle, remove };
}
