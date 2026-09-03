// WS HELLO S2C 能力集真源。canonical-state-v1 由客户端经 HELLO 消费。
export const API_VERSION = 1;

export const GATEWAY_CAPABILITY_CANONICAL_STATE_V1 = 'canonical-state-v1';

export const GATEWAY_CAPABILITIES = [GATEWAY_CAPABILITY_CANONICAL_STATE_V1] as const;
