import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import { emit } from '../core/cmd';
import type { CliContext } from '../core/context';

export async function jsonOn(
  ctx: CliContext,
  nodeId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return ctx.http.json(nodeId, method, path, body);
}

export async function jsonSelf(
  ctx: CliContext,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return jsonOn(ctx, await ctx.targetNodeId(), method, path, body);
}

export async function jsonEntry(
  ctx: CliContext,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return jsonOn(ctx, SELF_NODE_ID, method, path, body);
}

export function print(ctx: CliContext, payload: unknown): void {
  emit(ctx, payload, () => ctx.out.data(payload));
}
