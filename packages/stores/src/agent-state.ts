// Agent store 的状态形状与读写句柄类型：供 store 组合根与各行为模块共享，避免相互 import 成环。

import type {
  AgentMessageDto,
  AgentQueuedMessageDto,
  AgentSessionDto,
  AgentWriteMode,
} from '@tmex/shared';
import type { SessionInProgress } from './agent-thread';

export interface PendingConfirmationUi {
  id: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  createdAt: string;
}

/** 未持久化的草稿会话：首条消息发送时才落库（空草稿不进 DB） */
export interface DraftSession {
  /** 草稿代际标识：物化结果回填前用它判定草稿是否已被新的草稿取代 */
  key: string;
  /** 绑定 pane 所在的 mesh node；null 表示持有该会话的 gateway 自身 */
  nodeId: string | null;
  deviceId: string;
  paneId: string;
  providerId: string | null;
  modelId: string | null;
  /** snapshot 中该 pane 的标题，作为起源元数据兜底 */
  paneTitle: string | null;
  /** 预填到输入框的草稿 prompt（如 rsync 自动安装流程），由 ChatInput 消费一次 */
  prompt?: string | null;
}

/** 创建会话的可选参数（草稿物化时传入） */
export interface CreateSessionOptions {
  /** 绑定 pane 所在的 mesh node；缺省 / null 表示本 gateway */
  nodeId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  providerHostedTools?: string[];
  originPaneTitle?: string | null;
  writeMode?: AgentWriteMode;
}

/** 渲染数据部分：WS 事件处理只读写这一层，不依赖 action 句柄 */
export interface AgentStateData {
  sessions: Record<string, AgentSessionDto | undefined>;
  sessionOrder: string[];
  sessionsLoaded: boolean;
  activeSessionId: string | null;
  messages: Record<string, AgentMessageDto[] | undefined>;
  historyLoaded: Record<string, boolean | undefined>;
  inProgress: Record<string, SessionInProgress | undefined>;
  pendingConfirmations: Record<string, PendingConfirmationUi[] | undefined>;
  queued: Record<string, AgentQueuedMessageDto[] | undefined>;
  sending: Record<string, boolean | undefined>;
  draft: DraftSession | null;
  /** 当前草稿是否正在物化（创建 session 请求 in-flight），输入区据此禁用 */
  materializingDraft: boolean;
  // 新建 session 的默认写入模式（浏览器记忆，session 创建前也由开关控制）
  defaultWriteMode: AgentWriteMode;
}

export interface AgentActions {
  ensureInitialized: () => void;
  loadSessions: () => Promise<void>;
  refreshSession: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  createSession: (
    deviceId: string,
    paneId: string,
    options?: CreateSessionOptions
  ) => Promise<AgentSessionDto | null>;
  renameSession: (sessionId: string, title: string) => Promise<boolean>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  setWriteMode: (sessionId: string, writeMode: AgentWriteMode) => Promise<void>;
  setAllowControlChars: (sessionId: string, allow: boolean) => Promise<void>;
  setDefaultWriteMode: (writeMode: AgentWriteMode) => void;
  setSessionModel: (sessionId: string, providerId: string | null, modelId: string) => Promise<void>;
  rebindPane: (sessionId: string, paneId: string) => Promise<void>;
  loadHistory: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, text: string) => Promise<boolean>;
  enqueueMessage: (sessionId: string, text: string, steer?: boolean) => Promise<void>;
  editQueuedMessage: (sessionId: string, itemId: string, text: string) => Promise<void>;
  withdrawQueuedMessage: (sessionId: string, itemId: string) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
  decideConfirmation: (
    sessionId: string,
    confirmationId: string,
    approved: boolean,
    reason?: string
  ) => Promise<void>;
  // 草稿会话
  startDraft: (input: StartDraftInput) => void;
  updateDraft: (patch: Partial<Pick<DraftSession, 'providerId' | 'modelId'>>) => void;
  clearDraft: () => void;
  materializeDraft: () => Promise<AgentSessionDto | null>;
}

/** 起草参数：node + pane 定位，加上起源元数据与预填 prompt */
export interface StartDraftInput {
  /** 绑定 pane 所在的 mesh node；null 表示本 gateway */
  nodeId: string | null;
  deviceId: string;
  paneId: string;
  /** snapshot 中该 pane 的标题，作为起源元数据兜底 */
  paneTitle: string | null;
  /** 预填到输入框的草稿 prompt（如 rsync 自动安装流程），由 ChatInput 消费一次 */
  prompt?: string | null;
}

export interface AgentState extends AgentStateData, AgentActions {}

export type AgentSetState = (
  partial: Partial<AgentState> | ((prev: AgentState) => Partial<AgentState>)
) => void;
export type AgentGetState = () => AgentState;

/** 事件处理侧的窄化读写句柄：只覆盖渲染数据，便于单测直接驱动 */
export type AgentDataSetState = (
  partial: Partial<AgentStateData> | ((prev: AgentStateData) => Partial<AgentStateData>)
) => void;
export type AgentDataGetState = () => AgentStateData;

export function createInitialAgentStateData(): AgentStateData {
  return {
    sessions: {},
    sessionOrder: [],
    sessionsLoaded: false,
    activeSessionId: null,
    messages: {},
    historyLoaded: {},
    inProgress: {},
    pendingConfirmations: {},
    queued: {},
    sending: {},
    draft: null,
    materializingDraft: false,
    defaultWriteMode: 'confirm',
  };
}
