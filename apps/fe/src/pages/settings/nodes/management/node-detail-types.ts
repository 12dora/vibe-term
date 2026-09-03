// 节点详情的领域逻辑与类型：REST 通道、保存计划与基线推进。
//
// 单独成一个叶子模块，`node-detail-dialog.tsx`（渲染）与 `use-node-detail-state.ts`（状态）
// 都从这里取；否则 hook 要反向 import 组件文件，两者互为依赖。

import type { NodeRow } from '@/node/mesh-nodes';
import {
  type ApiClient,
  type DomainAccessPolicy,
  createNodeApiClient,
  fetchDomainAccess,
  updateDomainAccess,
} from '@tmex/api-client';
import { actionErrorText } from './errors';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 老节点没有这个端点：入口转发回 404 / 405，一律折成「该节点版本不支持」。 */
const UNSUPPORTED_STATUS = new Set([404, 405]);

export type DomainAccessState =
  | { kind: 'loading' }
  | { kind: 'ready'; allowed: boolean; viaDomain: boolean; hosts: string[] }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string };

/** 目标节点的 REST 客户端：本机退化成无前缀，远端走 `/n/<id>`。 */
export function nodeDetailClient(row: NodeRow): ApiClient {
  return createNodeApiClient(row.runtimeNodeId);
}

export interface NodeDetailIo {
  loadDomainAccess: (row: NodeRow) => Promise<DomainAccessPolicy>;
  saveDomainAccess: (row: NodeRow, allowed: boolean) => Promise<DomainAccessPolicy>;
  rename: (name: string) => Promise<void>;
}

export function createNodeDetailIo(rename: (name: string) => Promise<void>): NodeDetailIo {
  return {
    loadDomainAccess: (row) => fetchDomainAccess(nodeDetailClient(row)),
    saveDomainAccess: (row, allowed) => updateDomainAccess(allowed, nodeDetailClient(row)),
    rename,
  };
}

/**
 * 域名访问这条通道的失败文案。目标节点不可达时 `/n/<id>` 转发器回的是自己的顶层信封
 * （503 `NODE_UNREACHABLE`），照原样显示只会是一串大写代号，这里换成人话。
 */
export function domainAccessErrorText(t: Translate, err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (message === 'NODE_UNREACHABLE') return t('nodes.detail.domainAccessUnreachable');
  return actionErrorText(t, err);
}

export async function loadDomainAccessState(
  row: NodeRow,
  io: Pick<NodeDetailIo, 'loadDomainAccess'>,
  t: Translate
): Promise<DomainAccessState> {
  try {
    const policy = await io.loadDomainAccess(row);
    return {
      kind: 'ready',
      allowed: policy.allowed,
      viaDomain: policy.viaDomain === true,
      hosts: policy.hosts ?? [],
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== undefined && UNSUPPORTED_STATUS.has(status)) return { kind: 'unsupported' };
    return { kind: 'failed', message: domainAccessErrorText(t, err) };
  }
}

/** Switch 的开关请求：关闭是破坏性动作，先过确认框；打开直接落到草稿上。 */
export function toggleDomainAccess(
  next: boolean
): { kind: 'apply'; allowed: boolean } | { kind: 'confirm' } {
  return next ? { kind: 'apply', allowed: true } : { kind: 'confirm' };
}

export interface NodeDetailValues {
  name: string;
  /** 域名访问；未加载 / 不支持 / 读取失败时为 `null`，此项不参与保存。 */
  allowed: boolean | null;
}

export interface NodeDetailPlan {
  /** 要改的名字（已 trim）；不改名时为 `null`。 */
  renameTo: string | null;
  /** 要写的域名访问策略；不改时为 `null`。 */
  allowed: boolean | null;
}

export function planNodeDetailSave(
  baseline: NodeDetailValues,
  draft: NodeDetailValues
): NodeDetailPlan {
  const name = draft.name.trim();
  const allowedChanged =
    baseline.allowed !== null && draft.allowed !== null && draft.allowed !== baseline.allowed;
  return {
    renameTo: name && name !== baseline.name ? name : null,
    allowed: allowedChanged ? draft.allowed : null,
  };
}

export function hasNodeDetailChanges(plan: NodeDetailPlan): boolean {
  return plan.renameTo !== null || plan.allowed !== null;
}

export interface NodeDetailSaveContext {
  t: Translate;
  writerPublicUrl: string | null;
}

export interface NodeDetailSaveResult {
  ok: boolean;
  errors: string[];
  /** 改名这一条是否已落地；`plan.renameTo` 为空时恒 false。 */
  renamed: boolean;
  /** 域名访问这一条是否已落地；`plan.allowed` 为空时恒 false。 */
  domainSaved: boolean;
}

/** 两条通道各自执行、各自报错：改名失败不该把已经改好的域名访问一起吞掉。 */
export async function saveNodeDetail(
  row: NodeRow,
  plan: NodeDetailPlan,
  io: NodeDetailIo,
  { t, writerPublicUrl }: NodeDetailSaveContext
): Promise<NodeDetailSaveResult> {
  const errors: string[] = [];
  let renamed = false;
  let domainSaved = false;
  if (plan.renameTo !== null) {
    try {
      await io.rename(plan.renameTo);
      renamed = true;
    } catch (err) {
      errors.push(
        t('nodes.detail.renameFailed', { error: actionErrorText(t, err, { writerPublicUrl }) })
      );
    }
  }
  if (plan.allowed !== null) {
    try {
      await io.saveDomainAccess(row, plan.allowed);
      domainSaved = true;
    } catch (err) {
      errors.push(
        t('nodes.detail.domainAccessSaveFailed', { error: domainAccessErrorText(t, err) })
      );
    }
  }
  return { ok: errors.length === 0, errors, renamed, domainSaved };
}

/**
 * 一半成功一半失败之后的新基线：成功的那一条推进到已写入的值，重试时它就不再参与保存。
 * 不这么做的话，用户对着「改名成功、域名访问失败」的对话框再点一次保存，会把名字再改一遍。
 */
export function nextNodeDetailBaseline(
  baseline: NodeDetailValues,
  plan: NodeDetailPlan,
  result: Pick<NodeDetailSaveResult, 'renamed' | 'domainSaved'>
): NodeDetailValues {
  return {
    name: result.renamed && plan.renameTo !== null ? plan.renameTo : baseline.name,
    allowed: result.domainSaved && plan.allowed !== null ? plan.allowed : baseline.allowed,
  };
}
