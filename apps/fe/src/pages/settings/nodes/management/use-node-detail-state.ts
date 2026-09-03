import type { NodeRow } from '@/node/mesh-nodes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type DomainAccessState,
  type NodeDetailIo,
  type NodeDetailPlan,
  type NodeDetailValues,
  createNodeDetailIo,
  loadDomainAccessState,
  nextNodeDetailBaseline,
  planNodeDetailSave,
  saveNodeDetail,
  toggleDomainAccess,
} from './node-detail-types';

export interface NodeDetailState {
  baseline: NodeDetailValues;
  name: string;
  allowed: boolean | null;
  domainAccess: DomainAccessState;
  errors: string[];
  confirming: boolean;
  saving: boolean;
}

function initialState(row: NodeRow): NodeDetailState {
  return {
    baseline: { name: row.name, allowed: null },
    name: row.name,
    allowed: null,
    domainAccess: { kind: 'loading' },
    errors: [],
    confirming: false,
    saving: false,
  };
}

export interface NodeDetailStateOptions {
  writerPublicUrl: string | null;
  rename: (name: string) => Promise<void>;
  onChanged: () => void;
  onOpenChange: (open: boolean) => void;
  /** 测试注入；缺省走真实端点。 */
  io?: NodeDetailIo;
}

export interface NodeDetailStateHandle {
  state: NodeDetailState;
  patch: (next: Partial<NodeDetailState>) => void;
  plan: NodeDetailPlan;
  save: () => Promise<void>;
  onAllowedChange: (next: boolean) => void;
}

export function useNodeDetailState(
  row: NodeRow,
  open: boolean,
  { io, rename, writerPublicUrl, onChanged, onOpenChange }: NodeDetailStateOptions
): NodeDetailStateHandle {
  const { t } = useTranslation();
  const [state, setState] = useState<NodeDetailState>(() => initialState(row));
  const patch = useCallback(
    (next: Partial<NodeDetailState>) => setState((prev) => ({ ...prev, ...next })),
    []
  );

  // 列表每次轮询都会换一批新的 row 对象，io / rename 也随宿主重渲染重建：把它们收进 ref，
  // 加载效应才能只认「哪一行、开没开」，不被这些身份变化反复重跑。
  const latest = useRef({ row, io, rename, t });
  latest.current = { row, io, rename, t };
  const rowId = row.id;

  // 基线在打开这一刻定下（域名访问读回来后补上），之后不再跟着列表刷新走：
  // 轮询把 row.name 换掉时若跟着重置草稿，用户输一半的名字会凭空消失。
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowId 是「换了一行」的显式触发器，行对象本身走 ref
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const { row: target, io: injected, rename: renameNode, t: translate } = latest.current;
    setState(initialState(target));
    void loadDomainAccessState(target, injected ?? createNodeDetailIo(renameNode), translate).then(
      (domainAccess) => {
        if (!alive) return;
        const allowed = domainAccess.kind === 'ready' ? domainAccess.allowed : null;
        setState((prev) => ({
          ...prev,
          domainAccess,
          allowed,
          baseline: { ...prev.baseline, allowed },
        }));
      }
    );
    return () => {
      alive = false;
    };
  }, [open, rowId]);

  const plan = planNodeDetailSave(state.baseline, { name: state.name, allowed: state.allowed });

  const save = async () => {
    patch({ saving: true, errors: [] });
    const effective = io ?? createNodeDetailIo(rename);
    const result = await saveNodeDetail(row, plan, effective, { t, writerPublicUrl });
    // 成功的那一条先认账：只错了一半时再点保存，只会重发失败的那一条
    setState((prev) => ({
      ...prev,
      saving: false,
      errors: result.errors,
      baseline: nextNodeDetailBaseline(prev.baseline, plan, result),
    }));
    if (!result.ok) return;
    toast.success(t('nodes.detail.saved'));
    onChanged();
    onOpenChange(false);
  };

  const onAllowedChange = (next: boolean) => {
    const action = toggleDomainAccess(next);
    if (action.kind === 'confirm') patch({ confirming: true });
    else patch({ allowed: action.allowed });
  };

  return { state, patch, plan, save, onAllowedChange };
}
