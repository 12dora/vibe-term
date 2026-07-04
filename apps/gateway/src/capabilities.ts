// REST /api/capabilities 与 WS HELLO S2C 共用的唯一常量来源，避免两处漂移
export const API_VERSION = 1;

export const GATEWAY_CAPABILITIES = ['tmex-ws-borsh-v1', 'tmex-agent-v1', 'tmex-split-v1'] as const;
