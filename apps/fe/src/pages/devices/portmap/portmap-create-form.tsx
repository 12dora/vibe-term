// 新建映射表单的外壳：跑两侧探测，算出提交条件，其余交给字段与提示两个展示组件。
// 创建顺序（见 `portmap-actions.ts`）：先在目标节点 B 建放行记录拿 mapId，再拿它去监听节点 A 建映射。

import type { Dispatch, SetStateAction } from 'react';

import type { DialogNodeOption } from '../dialog-nodes';
import { PortMapFormFields, PortMapFormHints } from './portmap-form-fields';
import {
  type PortMapFormState,
  listenProbeBlock,
  portMapSubmitBlock,
  targetProbeHint,
} from './portmap-form-state';
import { useListenPortProbe, useTargetPortProbe } from './use-port-probe';

export interface PortMapCreateFormProps {
  state: PortMapFormState;
  setState: Dispatch<SetStateAction<PortMapFormState>>;
  options: DialogNodeOption[];
  submitting: boolean;
  errorKey: string | null;
  onSubmit: () => void;
}

export function PortMapCreateForm({
  state,
  setState,
  options,
  submitting,
  errorKey,
  onSubmit,
}: PortMapCreateFormProps) {
  const listenProbe = useListenPortProbe(state.listenNodeId, state.listenHost, state.listenPort);
  const targetProbe = useTargetPortProbe(state.targetNodeId, state.targetHost, state.targetPort);

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border p-2"
      data-testid="portmap-form"
    >
      <PortMapFormFields
        state={state}
        options={options}
        submitting={submitting}
        block={portMapSubmitBlock(state, listenProbe.value)}
        patch={(next) => setState((prev) => ({ ...prev, ...next }))}
        onSubmit={onSubmit}
      />
      <PortMapFormHints
        state={state}
        probeBlock={listenProbeBlock(listenProbe.value)}
        targetIdle={targetProbeHint(targetProbe.value) === 'idle'}
        errorKey={errorKey}
      />
    </section>
  );
}
