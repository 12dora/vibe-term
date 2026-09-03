// canonical v1.1 的几何语义：ResizePaneV11 携带 geometryReason + sizeEpoch，
// 把 legacy 时代由两个 kind（TERM_RESIZE / TERM_SYNC_SIZE）表达的区分搬到 canonical 线协议上。
//
// - change：浏览器/布局的视口真的变了，客户端必须先自增 sizeEpoch。
// - resend：暖切换、重连、焦点恢复后补发当前尺寸，复用上一次 change 的 sizeEpoch。
//
// sizeEpoch 按 (会话, pane) 单调递增且从 1 起，0 为保留值——网关据此把「没有记录过 epoch」
// 与「epoch 为 0」区分开，并丢弃比已记录值更旧的尺寸。

import type { CanonicalCommand } from './canonical-state';
import { ERROR_INVALID_FRAME, WsBorshError } from './errors';

export const CANONICAL_GEOMETRY_REASON_CHANGE = 0;
export const CANONICAL_GEOMETRY_REASON_RESEND = 1;

export const CanonicalGeometryReason = {
  Change: CANONICAL_GEOMETRY_REASON_CHANGE,
  Resend: CANONICAL_GEOMETRY_REASON_RESEND,
} as const;

export type CanonicalGeometryReason =
  (typeof CanonicalGeometryReason)[keyof typeof CanonicalGeometryReason];

export function isCanonicalGeometryReason(value: number): value is CanonicalGeometryReason {
  return value === CANONICAL_GEOMETRY_REASON_CHANGE || value === CANONICAL_GEOMETRY_REASON_RESEND;
}

export function assertCanonicalCommandSemantics(command: CanonicalCommand): void {
  if (!('ResizePaneV11' in command)) return;
  const { geometryReason, sizeEpoch } = command.ResizePaneV11;
  if (!isCanonicalGeometryReason(geometryReason)) {
    throw new WsBorshError(
      ERROR_INVALID_FRAME,
      false,
      `ResizePaneV11 unknown geometryReason ${geometryReason}`
    );
  }
  if (sizeEpoch <= 0n) {
    throw new WsBorshError(ERROR_INVALID_FRAME, false, 'ResizePaneV11 sizeEpoch must be positive');
  }
}
