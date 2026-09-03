// Agent session 契约

export type AgentWriteMode = 'confirm' | 'auto';

export type AgentSessionStatus = 'idle' | 'running' | 'waiting_confirmation' | 'stopped' | 'error';

export type AgentConfirmationStatus = 'pending' | 'approved' | 'denied' | 'cancelled';

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 新建 session 的默认标题，标题仍为该值时服务端会在首回合结束后自动生成 */
export const DEFAULT_AGENT_SESSION_TITLE = 'New Session';

export interface AgentSessionDto {
  id: string;
  title: string;
  /** 绑定 pane 所在的 mesh node；null 表示拥有该 session 的 gateway 自身（self） */
  nodeId: string | null;
  deviceId: string | null;
  paneId: string | null;
  providerId: string | null;
  modelId: string;
  systemPrompt: string | null;
  writeMode: AgentWriteMode;
  useProviderWebSearch: boolean;
  /** 启用的 provider 原生 hosted 工具 key（如 image_generation） */
  providerHostedTools: string[];
  /** 允许 send_input 写入原始控制字符（需显式开启，默认 false） */
  allowControlChars: boolean;
  /** 起源元数据：创建时绑定 pane 的终端标题/进程名（旧记录为 null） */
  originPaneTitle: string | null;
  originProcessName: string | null;
  status: AgentSessionStatus;
  lastError: string | null;
  maxStepsPerTurn: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentQueuedMessageDto {
  id: string;
  sessionId: string;
  seq: number;
  text: string;
  createdAt: string;
}

export interface AgentMessageDto {
  id: string;
  sessionId: string;
  seq: number;
  role: AgentMessageRole;
  /** AI SDK ModelMessage 原样 JSON */
  content: unknown;
  createdAt: string;
}

export interface AgentConfirmationDto {
  id: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  status: AgentConfirmationStatus;
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
}
