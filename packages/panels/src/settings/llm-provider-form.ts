import type { LlmProviderDto, LlmProviderProtocol } from '@vibeterm/shared';

/** 改接口地址或协议后已存的 API Key 不能沿用，必须同时重新输入（网关同口径，否则 400 `API_KEY_REQUIRED`）。 */
export function apiKeyRequiredOnEdit(
  provider: Pick<LlmProviderDto, 'baseUrl' | 'protocol'>,
  draft: { baseUrl: string; protocol: LlmProviderProtocol }
): boolean {
  return draft.baseUrl.trim() !== provider.baseUrl || draft.protocol !== provider.protocol;
}
