import type { Device } from '@tmex/shared';
import type { LanguageModel, LanguageModelMiddleware, ModelMessage, Tool, ToolSet } from 'ai';
import { stepCountIs, wrapLanguageModel } from 'ai';
import type { PaneEmulator } from '../tmux-client/pane-emulator';
import { buildAgentSystemPrompt, collectAgentEnvironment } from './prompts';
import { createRedactionMiddleware } from './redaction-middleware';
import {
  type CreateTerminalToolsOptions,
  type TerminalRuntimeLike,
  createTerminalTools,
} from './tools/terminal';

export const MESSAGE_WINDOW_CHAR_BUDGET = 200_000;

/**
 * 历史消息滑窗：超出字符预算时从最旧开始丢弃，截断点必须落在 user 消息边界
 * （保证 assistant tool-call 与对应 tool-result 不被拆散、approval 链完整）。
 * - 预算内：原样返回
 * - 超预算：保留从"预算内最早的 user 消息"开始的后缀
 * - 连最后一条 user 起的后缀都超预算：仍从最后一条 user 开始保留（合法性优先于预算）
 * - 没有任何 user 消息：原样返回（无合法截断点）
 */
export function applyMessageWindow(
  messages: ModelMessage[],
  charBudget: number = MESSAGE_WINDOW_CHAR_BUDGET
): ModelMessage[] {
  const sizes = messages.map((message) => JSON.stringify(message).length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= charBudget) {
    return messages;
  }

  let suffixSize = 0;
  let lastUserIndex = -1;
  let bestUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    suffixSize += sizes[i] ?? 0;
    if (messages[i]?.role === 'user') {
      if (lastUserIndex < 0) {
        lastUserIndex = i;
      }
      if (suffixSize <= charBudget) {
        bestUserIndex = i;
      }
    }
  }

  if (lastUserIndex < 0) {
    return messages;
  }
  const start = bestUserIndex >= 0 ? bestUserIndex : lastUserIndex;
  if (start === 0) {
    return messages;
  }
  return messages.slice(start);
}

export function resolveMaxStepsPerTurn(maxStepsPerTurn: number): number {
  return Math.max(1, maxStepsPerTurn);
}

export type WrapRunModelFn = (args: {
  model: Exclude<LanguageModel, string>;
  middleware: LanguageModelMiddleware;
}) => LanguageModel;

export function wrapRunModel(
  resolvedModel: LanguageModel,
  wrap?: WrapRunModelFn,
  createMiddleware?: () => LanguageModelMiddleware
): LanguageModel {
  if (typeof resolvedModel === 'string') {
    return resolvedModel;
  }
  const wrapFn = wrap ?? (wrapLanguageModel as WrapRunModelFn);
  return wrapFn({
    model: resolvedModel,
    middleware: (createMiddleware ?? createRedactionMiddleware)(),
  });
}

export interface BuiltRunRequest {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  stopWhen: ReturnType<typeof stepCountIs>;
  providerOptions: { openai: { store: false } };
}

export function buildRunRequest(input: {
  messages: ModelMessage[];
  resolvedModel: LanguageModel;
  tools: ToolSet;
  paneId: string | null;
  writeMode: 'confirm' | 'auto';
  customSystemPrompt: string | null;
  maxStepsPerTurn: number;
  device: Device | null;
  charBudget?: number;
  wrapModel?: WrapRunModelFn;
  createMiddleware?: () => LanguageModelMiddleware;
}): BuiltRunRequest {
  return {
    model: wrapRunModel(input.resolvedModel, input.wrapModel, input.createMiddleware),
    system: buildAgentSystemPrompt({
      paneId: input.paneId,
      writeMode: input.writeMode,
      customSystemPrompt: input.customSystemPrompt,
      environment: collectAgentEnvironment(input.device),
    }),
    messages: applyMessageWindow(input.messages, input.charBudget),
    tools: input.tools,
    stopWhen: stepCountIs(resolveMaxStepsPerTurn(input.maxStepsPerTurn)),
    providerOptions: { openai: { store: false } },
  };
}

export interface BuildRunToolsParams {
  paneId: string | null;
  deviceId: string | null;
  writeMode: 'confirm' | 'auto';
  allowControlChars: boolean;
  useProviderWebSearch: boolean;
  providerId: string | null;
  providerHostedTools: readonly string[];
  runtime: TerminalRuntimeLike | null;
  getEmulator: () => PaneEmulator | null;
  onFailure: () => void;
  onSuccess: () => void;
  sleepMs: (ms: number) => Promise<void>;
  resolveProviderWebSearchTool: (providerId: string | null) => Promise<Tool | null>;
  resolveProviderHostedTools: (
    providerId: string | null,
    keys: readonly string[]
  ) => Promise<Record<string, Tool>>;
  createWebSearchTool: () => Promise<Tool | null>;
  createFetchUrlTool: () => Tool;
  createTerminalTools?: (options: CreateTerminalToolsOptions) => Record<string, Tool>;
}

export async function buildRunTools(params: BuildRunToolsParams): Promise<ToolSet> {
  const tools: Record<string, Tool> = {};
  const makeTerminalTools = params.createTerminalTools ?? createTerminalTools;

  if (params.runtime && params.paneId) {
    const runtime = params.runtime;
    Object.assign(
      tools,
      makeTerminalTools({
        paneId: params.paneId,
        deviceId: params.deviceId ?? '',
        getRuntime: () => runtime,
        getEmulator: params.getEmulator,
        isRuntimeAlive: () => runtime != null && !runtime.isTerminated,
        allowControlChars: params.allowControlChars,
        needsApprovalForWrite: params.writeMode === 'confirm',
        onFailure: params.onFailure,
        onSuccess: params.onSuccess,
        sleepMs: params.sleepMs,
      })
    );
  }

  if (params.useProviderWebSearch) {
    const providerTool = await params.resolveProviderWebSearchTool(params.providerId);
    if (providerTool) {
      tools.web_search = providerTool;
    }
  } else {
    const webSearch = await params.createWebSearchTool();
    if (webSearch) {
      tools.web_search = webSearch;
    }
  }

  if (params.providerHostedTools.length > 0) {
    const hostedTools = await params.resolveProviderHostedTools(
      params.providerId,
      params.providerHostedTools
    );
    Object.assign(tools, hostedTools);
  }

  tools.fetch_url = params.createFetchUrlTool();
  return tools;
}
