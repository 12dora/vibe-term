// 草稿会话动作：草稿的开启/更新/清空，以及首条消息触发的物化。草稿按 node 分片存放。

import type { AgentSessionDto } from '@tmex/shared';
import { agentNodeKey } from './agent-node-state';
import { createSessionRequest } from './agent-session-crud-actions';
import type { AgentSessionActionsDeps } from './agent-session-deps';
import type { AgentActions, DraftSession } from './agent-state';

export type AgentSessionDraftActions = Pick<
  AgentActions,
  'startDraft' | 'updateDraft' | 'clearDraft' | 'materializeDraft'
>;

export function createAgentSessionDraftActions(
  deps: AgentSessionActionsDeps
): AgentSessionDraftActions {
  const { set, get, unsubscribe } = deps;

  let draftSequence = 0;
  // 草稿物化的 in-flight 去重：同一草稿的并发调用共享同一个请求，避免重复建会话
  const materializing = new Map<string, Promise<AgentSessionDto | null>>();

  function setDraft(nodeKey: string, draft: DraftSession | null): void {
    set((prev) => ({ draftByNode: { ...prev.draftByNode, [nodeKey]: draft } }));
  }

  function syncMaterializingFlag(nodeKey: string): void {
    const draftKey = get().draftByNode[nodeKey]?.key ?? null;
    const pending = draftKey !== null && materializing.has(draftKey);
    if ((get().materializingDraftByNode[nodeKey] ?? false) === pending) return;
    set((prev) => ({
      materializingDraftByNode: { ...prev.materializingDraftByNode, [nodeKey]: pending },
    }));
  }

  async function materializeDraftRequest(draft: DraftSession): Promise<AgentSessionDto | null> {
    const nodeKey = agentNodeKey(draft.nodeId);
    const session = await createSessionRequest(deps, draft.deviceId, draft.paneId, {
      nodeId: draft.nodeId,
      providerId: draft.providerId,
      modelId: draft.modelId,
      originPaneTitle: draft.paneTitle,
    });
    // 请求期间用户可能已切到新草稿或别的会话：过期结果只入库，不抢占当前选择
    if (session && get().draftByNode[nodeKey]?.key === draft.key) {
      // setActiveSession 内部清空该 node 的草稿
      get().setActiveSession(session.id, draft.nodeId);
    }
    return session;
  }

  return {
    startDraft(input) {
      const nodeKey = agentNodeKey(input.nodeId);
      const previous = get().activeSessionIdByNode[nodeKey] ?? null;
      if (previous) {
        unsubscribe(previous);
      }
      // 默认模型继承全局默认（modelId=null → 后端回退默认）；provider 同理
      draftSequence += 1;
      set((prev) => ({
        activeSessionIdByNode: { ...prev.activeSessionIdByNode, [nodeKey]: null },
        materializingDraftByNode: { ...prev.materializingDraftByNode, [nodeKey]: false },
        draftByNode: {
          ...prev.draftByNode,
          [nodeKey]: {
            key: `draft-${draftSequence}`,
            nodeId: input.nodeId,
            deviceId: input.deviceId,
            paneId: input.paneId,
            providerId: null,
            modelId: null,
            paneTitle: input.paneTitle,
            prompt: input.prompt ?? null,
          },
        },
      }));
    },

    updateDraft(nodeId, patch) {
      const nodeKey = agentNodeKey(nodeId);
      const draft = get().draftByNode[nodeKey];
      if (!draft) return;
      setDraft(nodeKey, { ...draft, ...patch });
    },

    clearDraft(nodeId) {
      const nodeKey = agentNodeKey(nodeId);
      setDraft(nodeKey, null);
      syncMaterializingFlag(nodeKey);
    },

    materializeDraft(nodeId) {
      const nodeKey = agentNodeKey(nodeId);
      const draft = get().draftByNode[nodeKey];
      if (!draft) return Promise.resolve(null);
      const inFlight = materializing.get(draft.key);
      if (inFlight) return inFlight;
      const pending = materializeDraftRequest(draft).finally(() => {
        materializing.delete(draft.key);
        syncMaterializingFlag(nodeKey);
      });
      materializing.set(draft.key, pending);
      syncMaterializingFlag(nodeKey);
      return pending;
    },
  };
}
