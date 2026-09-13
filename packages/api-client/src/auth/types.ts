// mesh 身份鉴权相关的 REST 报文类型（设计见 docs/architecture/mesh-architecture.md §2 / §4）。
// 所有二进制字段一律 base64url（无 padding）字符串，与 `@vibeterm/shared/auth` 的 encodeBase64url 对齐。
// 主题模块拆在 types-*.ts；本文件只做 re-export，调用方 import 路径不变。

export type { AuthTotpRecordResponse } from '@vibeterm/shared';
export type { HubEndpointInfo, HubMode } from '@vibeterm/shared/uplink';

export * from './types-mode';
export * from './types-login';
export * from './types-mesh';
export * from './types-hub';
export * from './types-keylog';
export * from './types-passkey';
