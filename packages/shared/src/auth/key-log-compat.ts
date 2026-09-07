// 记录类型的版本门：写入前要求全网未吊销节点都达到最低版本，否则旧节点解不开新记录，
// 密钥日志同步会卡在那一条上。表与常量单独成文件，key-log.ts 只做转出。

import type { KeyLogType } from './encoding';
import { MIN_RELAY_RECORD_VERSION } from './relay-records';

/** 写入 `admit-hub` / `retire-hub` 前，所有未吊销节点须达到该版本，否则旧节点无法解码新记录。 */
export const MIN_HUB_AUTH_RECORD_VERSION = '1.1.13';
/** 写入 `rotate-root-keep` 前，所有未吊销节点须达到该版本；不允许 force 绕过。 */
export const MIN_ROTATE_ROOT_KEEP_RECORD_VERSION = '1.1.16';
/** 写入 `rename-node` 前，所有未吊销节点须达到该版本；不允许 force 绕过。 */
export const MIN_RENAME_NODE_RECORD_VERSION = '1.1.24';
/** 写入 `readmit-node` 前，所有未吊销节点须达到该版本；不允许 force 绕过。 */
export const MIN_READMIT_NODE_RECORD_VERSION = '1.1.26';
/** 写入 `notification-sink` 前，所有未吊销节点须达到该版本；不允许 force 绕过。 */
export const MIN_NOTIFICATION_SINK_RECORD_VERSION = '1.1.39';
export const KEYLOG_TYPE_UNSUPPORTED_BY_NODES = 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES';
export const HUB_AUTH_RECORD_TYPES = ['admit-hub', 'retire-hub'] as const;
export const ROTATE_ROOT_KEEP_RECORD_TYPES = ['rotate-root-keep'] as const;

export type KeyLogRecordCompatSpec = {
  minVersion: string;
  allowForce: boolean;
  /**
   * 版本未知的成员也要挡住。
   *
   * 中继模式下 `peer_cache` 只覆盖握过手的对端，一台离线的已入网节点在表里没有行、版本无从得知；
   * 默认策略是「已有其它对端可比对时跳过这些行」（否则首台接入永远写不进去）。
   * 但对**旧节点解不开就会卡住整条链**的记录类型，跳过等于把对方的密钥日志同步写死，
   * 因此这类记录一律 fail closed：宁可拒写，也不能写坏别人的链。
   */
  failClosedUncached?: boolean;
};

export const RELAY_RECORD_TYPES = ['set-relays', 'meta-key'] as const;
export const RENAME_NODE_RECORD_TYPES = ['rename-node'] as const;

export const KEYLOG_RECORD_COMPAT: Readonly<Partial<Record<KeyLogType, KeyLogRecordCompatSpec>>> = {
  'set-relays': { minVersion: MIN_RELAY_RECORD_VERSION, allowForce: false },
  'meta-key': { minVersion: MIN_RELAY_RECORD_VERSION, allowForce: false },
  'rename-node': { minVersion: MIN_RENAME_NODE_RECORD_VERSION, allowForce: false },
  'readmit-node': {
    minVersion: MIN_READMIT_NODE_RECORD_VERSION,
    allowForce: false,
    failClosedUncached: true,
  },
  'notification-sink': {
    minVersion: MIN_NOTIFICATION_SINK_RECORD_VERSION,
    allowForce: false,
    failClosedUncached: true,
  },
  'admit-hub': { minVersion: MIN_HUB_AUTH_RECORD_VERSION, allowForce: true },
  'retire-hub': { minVersion: MIN_HUB_AUTH_RECORD_VERSION, allowForce: true },
  'rotate-root-keep': {
    minVersion: MIN_ROTATE_ROOT_KEEP_RECORD_VERSION,
    allowForce: false,
    failClosedUncached: true,
  },
};
