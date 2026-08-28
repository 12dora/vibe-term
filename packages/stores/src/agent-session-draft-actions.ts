// 草稿会话动作：草稿的开启/更新/清空，以及首条消息触发的物化。

import type { AgentSessionDto } from '@tmex/shared';
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

  function syncMaterializingFlag(): void {
    const draftKey = get().draft?.key ?? null;
    const pending = draftKey !== null && materializing.has(draftKey);
    if (get().materializingDraft !== pending) {
      set({ materializingDraft: pending });
    }
  }

  async function materializeDraftRequest(draft: DraftSession): Promise<AgentSessionDto | null> {
    const session = await createSessionRequest(deps, draft.deviceId, draft.paneId, {
      providerId: draft.providerId,
      modelId: draft.modelId,
      originPaneTitle: draft.paneTitle,
    });
    // 请求期间用户可能已切到新草稿或别的会话：过期结果只入库，不抢占当前选择
    if (session && get().draft?.key === draft.key) {
      // setActiveSession 内部清空草稿
      get().setActiveSession(session.id);
    }
    return session;
  }

  return {
    startDraft(deviceId, paneId, paneTitle, prompt) {
      const previous = get().activeSessionId;
      if (previous) {
        unsubscribe(previous);
      }
      // 默认模型继承全局默认（modelId=null → 后端回退默认）；provider 同理
      draftSequence += 1;
      set({
        activeSessionId: null,
        materializingDraft: false,
        draft: {
          key: `draft-${draftSequence}`,
          deviceId,
          paneId,
          providerId: null,
          modelId: null,
          paneTitle,
          prompt: prompt ?? null,
        },
      });
    },

    updateDraft(patch) {
      set((prev) => (prev.draft ? { draft: { ...prev.draft, ...patch } } : prev));
    },

    clearDraft() {
      set({ draft: null, materializingDraft: false });
    },

    materializeDraft() {
      const draft = get().draft;
      if (!draft) return Promise.resolve(null);
      const inFlight = materializing.get(draft.key);
      if (inFlight) return inFlight;
      const pending = materializeDraftRequest(draft).finally(() => {
        materializing.delete(draft.key);
        syncMaterializingFlag();
      });
      materializing.set(draft.key, pending);
      syncMaterializingFlag();
      return pending;
    },
  };
}
