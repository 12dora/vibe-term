// WS HELLO S2C 能力集真源。canonical-state-v1 由客户端经 HELLO 消费。
export const API_VERSION = 1;

export const GATEWAY_CAPABILITY_CANONICAL_STATE_V1 = 'canonical-state-v1';

// canonical v1.1：ResizePaneV11（geometryReason + sizeEpoch）与 metadata 里的
// SOURCE_FIELD_TREE_ORDER。播报它等于承诺不再依赖 legacy state stream 兜底，
// 因此还要配合 CANONICAL_V11_MIN_PEER_VERSION 校验对端版本（见 ws-borsh/canonical-version.ts）。
export const GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1 = 'canonical-state-v1.1';

export const GATEWAY_CAPABILITIES = [
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1,
  GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1,
] as const;
