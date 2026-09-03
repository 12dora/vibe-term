// LLM provider 与 Agent LLM 设置契约

export type LlmProviderProtocol = 'openai-chat' | 'openai-responses';

/** 'none' 为固定语义（不启用搜索）；其余为已注册 search provider 的 id（内建 tavily/brave 或运行时注册的自定义 id） */
export type AgentSearchProvider = 'none' | 'tavily' | 'brave' | (string & {});

/** 可用搜索 provider 描述（GET /api/llm/settings 返回，供前端数据驱动渲染选项） */
export interface SearchProviderInfoDto {
  id: string;
  label: string;
  isConfigured: boolean;
}

export type LlmModelSource = 'fetched' | 'manual';

export interface LlmModelInfo {
  id: string;
  source: LlmModelSource;
  enabled: boolean;
}

export interface LlmProviderDto {
  id: string;
  name: string;
  protocol: LlmProviderProtocol;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  /** effective 启用模型列表 =（拉取 ∪ 手动）− 禁用，供 Agent/默认模型选择器使用 */
  models: string[];
  /** 全量模型（含来源与启用态），供设置页逐个启停 */
  modelDetails: LlmModelInfo[];
  modelsFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListLlmProvidersResponse {
  providers: LlmProviderDto[];
}

export interface CreateLlmProviderRequest {
  name: string;
  protocol: LlmProviderProtocol;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
}

export interface CreateLlmProviderResponse {
  provider: LlmProviderDto;
  modelsError?: string;
}

export interface UpdateLlmProviderRequest {
  name?: string;
  protocol?: LlmProviderProtocol;
  baseUrl?: string;
  /** 留空或缺省表示不修改 */
  apiKey?: string;
  enabled?: boolean;
  /** 手动添加的模型 id 全量覆盖 */
  manualModels?: string[];
  /** 被禁用的模型 id 全量覆盖 */
  disabledModels?: string[];
}

export interface UpdateLlmProviderResponse {
  provider: LlmProviderDto;
  modelsError?: string;
}

export interface RefreshLlmProviderModelsResponse {
  models: string[];
}

export interface AgentLlmSettingsDto {
  searchProvider: AgentSearchProvider;
  hasTavilyApiKey: boolean;
  hasBraveApiKey: boolean;
  defaultProviderId: string | null;
  defaultModelId: string | null;
  updatedAt: string;
}

export interface GetAgentLlmSettingsResponse {
  settings: AgentLlmSettingsDto;
  searchProviders: SearchProviderInfoDto[];
}

export interface UpdateAgentLlmSettingsRequest {
  searchProvider?: AgentSearchProvider;
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  /** 缺省表示不修改，空串表示清除 */
  tavilyApiKey?: string;
  /** 缺省表示不修改，空串表示清除 */
  braveApiKey?: string;
}
