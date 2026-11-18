// 远程升级推包阶段的偏移查询与清单：从作业状态机拆出，避免 job 文件越过行数门禁。
import { withTimeout } from '@vibeterm/shared';
import {
  asAuthForwardError,
  consumeBoundedBody,
  parseStagedStatusBody,
  pushPackageManifest,
  throwIfForwardAuth,
} from './remote-upgrade-io';
import type { AuthorizedUpgradeForward } from './upgrade-service';

/** 问一次已收偏移的超时；问不到就当 0 从头推，不值得为它挂住整个阶段。 */
const OFFSET_QUERY_TIMEOUT_MS = 30 * 1000;

/** 目标那边的暂存进度。`complete` 只在正式暂存包已落位时为真。 */
export type StagedOffset = {
  offset: number;
  complete: boolean;
  ranges: Array<{ offset: number; length: number }>;
};

const NO_STAGED_OFFSET: StagedOffset = { offset: 0, complete: false, ranges: [] };

/**
 * 查目标已收到多少字节；查不动就当 0（从头重传，最坏也只是多花一次带宽）。
 * `receivedBytes === totalBytes` 但 `complete === false` 表示 `.part` 写满了却没提交：
 * 仍要发一次零长度 PUT 让目标校验 sha256 并提交，不能当成已推完直接启动升级。
 * 401 立刻抛 `auth: …`，由 `runPush` 外层结束作业，不能吞成 offset=0。
 */
export async function readPushedOffset(input: {
  forward: AuthorizedUpgradeForward;
  req: Request;
  nodeId: string;
  version: string;
  sha256: string;
  totalBytes: number;
  signal: AbortSignal;
}): Promise<StagedOffset> {
  try {
    const res = await withTimeout(
      input.forward.forwardAuthorizedHttp(input.req, {
        nodeId: input.nodeId,
        method: 'GET',
        path: '/api/system/upgrade/package',
        query: `?version=${encodeURIComponent(input.version)}&sha256=${input.sha256}`,
        signal: input.signal,
      }),
      OFFSET_QUERY_TIMEOUT_MS,
      'offset timeout'
    );
    const text = await consumeBoundedBody(res);
    throwIfForwardAuth(res.status, text);
    if (res.status < 200 || res.status >= 300) return NO_STAGED_OFFSET;
    return parseStagedStatusBody(text, input.totalBytes);
  } catch (err) {
    const auth = asAuthForwardError(err);
    if (auth) throw err;
    return NO_STAGED_OFFSET;
  }
}

export function sendPackageManifest(input: {
  forward: AuthorizedUpgradeForward;
  req: Request;
  nodeId: string;
  version: string;
  asset: string;
  signal: AbortSignal;
  sums: string;
  sig: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.sig) {
    return Promise.resolve({ ok: false, error: 'push failed: RELEASE_UNSIGNED' });
  }
  return pushPackageManifest({
    forward: input.forward,
    req: input.req,
    nodeId: input.nodeId,
    version: input.version,
    sums: input.sums,
    sig: input.sig,
    asset: input.asset,
    signal: input.signal,
  });
}

/** 盘上的半成品与 sha 对不上：续传救不回来，整包重传一次（只退一次，避免来回刷带宽）。 */
export function shouldReuploadFromZero(error: string, offset: number): boolean {
  return offset > 0 && error.includes('PACKAGE_SHA256_MISMATCH');
}

/** 推包传输层抛出的 `auth: …` 必须原样冒泡，不能被收成可重试的链路错误。 */
export function rethrowIfAuthForward(err: unknown): void {
  const auth = asAuthForwardError(err);
  if (auth) throw err instanceof Error ? err : new Error(auth);
}
