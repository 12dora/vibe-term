import {
  type RemoteUpgradeChannel,
  combineAbortSignals,
  errorMessage,
  withTimeout,
} from '@vibeterm/shared';
import { consumeBoundedBody } from './remote-upgrade-io';
import type { AuthorizedUpgradeForward } from './upgrade-service';

export type DeliveryStepResult<T> =
  | { kind: 'done'; snapshot: T }
  | { kind: 'fallback'; detail: string };

export function jobCapabilities(raw?: readonly string[]): string[] {
  return [...(raw ?? ['staged-package', 'upgrade-cancel'])];
}

export function initialUpgradeChannel(capabilities: readonly string[]): RemoteUpgradeChannel {
  return capabilities.includes('release-speed-probe') ? 'node-github' : 'push';
}

export function initialUpgradePhase(
  capabilities: readonly string[]
): 'download' | 'push' | 'start' {
  return capabilities.includes('release-speed-probe') ? 'start' : 'download';
}

export function runUpgradeDelivery<T>(input: {
  hasSpeedProbe: boolean;
  hasStagedPackage: boolean;
  tryNodeGithub: (requireFastSource: boolean) => Promise<DeliveryStepResult<T>>;
  runPushPipeline: () => Promise<DeliveryStepResult<T>>;
  fail: (error: string) => T;
}): Promise<T> {
  return runUpgradeDeliveryTree(input);
}

async function runUpgradeDeliveryTree<T>(input: {
  hasSpeedProbe: boolean;
  hasStagedPackage: boolean;
  tryNodeGithub: (requireFastSource: boolean) => Promise<DeliveryStepResult<T>>;
  runPushPipeline: () => Promise<DeliveryStepResult<T>>;
  fail: (error: string) => T;
}): Promise<T> {
  const attempts: Array<{ channel: RemoteUpgradeChannel; detail: string }> = [];
  if (input.hasSpeedProbe) {
    const gated = await input.tryNodeGithub(true);
    if (gated.kind === 'done') return gated.snapshot;
    attempts.push({ channel: 'node-github', detail: gated.detail });
  }
  if (input.hasStagedPackage) {
    const pushed = await input.runPushPipeline();
    if (pushed.kind === 'done') return pushed.snapshot;
    attempts.push({ channel: 'push', detail: pushed.detail });
  }
  const forced = await input.tryNodeGithub(false);
  if (forced.kind === 'done') return forced.snapshot;
  attempts.push({ channel: 'node-github-forced', detail: forced.detail });
  return input.fail(formatDeliveryError(attempts));
}

export function formatDeliveryError(
  attempts: Array<{ channel: RemoteUpgradeChannel; detail: string }>
): string {
  return attempts.map((row) => `${channelLabel(row.channel)}: ${row.detail}`).join('; ');
}

export function channelLabel(channel: RemoteUpgradeChannel): string {
  if (channel === 'node-github') return 'github(node)';
  if (channel === 'node-github-forced') return 'github(node, forced)';
  return 'push';
}

export function summarizeChannelFailure(channel: RemoteUpgradeChannel, raw: string): string {
  const text = raw.trim();
  if (channel === 'node-github' || channel === 'node-github-forced') {
    return summarizeNodeGithubFailure(text);
  }
  return summarizePushFailure(text);
}

function summarizeNodeGithubFailure(text: string): string {
  const slow = /^slow\b/i.test(text);
  if (slow) return text;
  if (/unreachable/i.test(text)) return 'unreachable';
  if (/timeout/i.test(text)) return 'timeout';
  if (/fetch failed|http \d+|network/i.test(text)) return 'fetch failed';
  return stripPrefix(text, ['start failed: ', 'download failed: ']);
}

function summarizePushFailure(text: string): string {
  if (/timeout/i.test(text)) return 'timeout';
  if (/NODE_UNREACHABLE/.test(text)) return 'NODE_UNREACHABLE';
  if (/tarball HTTP|fetch failed|network/i.test(text)) return 'fetch failed';
  if (/^download failed:/i.test(text)) return stripPrefix(text, ['download failed: ']);
  if (/^start failed:/i.test(text)) return stripPrefix(text, ['start failed: ']);
  if (/^push failed:/i.test(text)) return stripPrefix(text, ['push failed: ']);
  if (/^manifest failed:/i.test(text)) return stripPrefix(text, ['manifest failed: ']);
  return text;
}

function stripPrefix(text: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
      return text.slice(prefix.length).trim() || text;
    }
  }
  return text;
}

export function formatSlowProbe(bytes: number, elapsedMs: number): string {
  const kb = bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${Math.max(0, Math.round(bytes))}B`;
  const seconds =
    elapsedMs >= 1000 ? `${Math.round(elapsedMs / 1000)}s` : `${Math.max(0, elapsedMs)}ms`;
  return `slow ${kb}/${seconds}`;
}

export type NodeReleaseStartKind =
  | 'accepted'
  | 'slow'
  | 'unreachable'
  | 'busy'
  | 'rejected'
  | 'error';

export type NodeReleaseStartResult = {
  kind: NodeReleaseStartKind;
  detail: string;
};

export async function postNodeReleaseUpgrade(input: {
  forward: AuthorizedUpgradeForward;
  req: Request;
  nodeId: string;
  version: string;
  requireFastSource: boolean;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<NodeReleaseStartResult> {
  try {
    const res = await withTimeout(
      input.forward.forwardAuthorizedHttp(input.req, {
        nodeId: input.nodeId,
        method: 'POST',
        path: '/api/system/upgrade',
        body: {
          version: input.version,
          source: 'release',
          requireFastSource: input.requireFastSource,
        },
        signal: combineAbortSignals(input.signal, AbortSignal.timeout(input.timeoutMs)),
      }),
      input.timeoutMs,
      'start timeout'
    );
    return await classifyNodeReleaseResponse(res);
  } catch (err) {
    if (input.signal.aborted) return { kind: 'error', detail: 'cancelled' };
    const message = errorMessage(err);
    if (message.includes('start timeout') || /timeout/i.test(message)) {
      return { kind: 'error', detail: 'timeout' };
    }
    if (/fetch failed|network|ECONN|ENOTFOUND/i.test(message)) {
      return { kind: 'unreachable', detail: 'unreachable' };
    }
    return { kind: 'error', detail: message };
  }
}

async function classifyNodeReleaseResponse(res: Response): Promise<NodeReleaseStartResult> {
  if (res.status >= 200 && res.status < 300) {
    await consumeBoundedBody(res);
    return { kind: 'accepted', detail: 'ok' };
  }
  const body = await readJsonObject(res);
  const code = typeof body?.code === 'string' ? body.code : '';
  const error = typeof body?.error === 'string' ? body.error : '';
  if (res.status === 409 && code === 'RELEASE_SLOW') {
    const bytes = typeof body?.bytes === 'number' ? body.bytes : 0;
    const elapsedMs = typeof body?.elapsedMs === 'number' ? body.elapsedMs : 0;
    return { kind: 'slow', detail: formatSlowProbe(bytes, elapsedMs) };
  }
  if (res.status === 409 && code === 'RELEASE_UNREACHABLE') {
    return { kind: 'unreachable', detail: 'unreachable' };
  }
  if (code === 'UPGRADE_IN_PROGRESS') return { kind: 'busy', detail: 'UPGRADE_IN_PROGRESS' };
  const detail = [code, error].filter(Boolean).join(' ').trim() || `HTTP ${res.status}`;
  if (res.status === 503 && /NODE_UNREACHABLE/.test(detail)) {
    return { kind: 'unreachable', detail: 'unreachable' };
  }
  return { kind: 'rejected', detail };
}

export type NodeGithubJob = {
  nodeId: string;
  version: string;
  abort: AbortController;
  channel: RemoteUpgradeChannel;
  phase: 'download' | 'push' | 'start';
  state: string;
  error: string | null;
};

export async function runNodeGithubChannel<T>(opts: {
  job: NodeGithubJob;
  requireFastSource: boolean;
  forward: AuthorizedUpgradeForward;
  req: Request;
  timeoutMs: number;
  snapshot: () => T;
  fail: (error: string) => T;
  markCancelled: () => T;
  isCancelled: () => boolean;
}): Promise<DeliveryStepResult<T>> {
  const job = opts.job;
  job.channel = opts.requireFastSource ? 'node-github' : 'node-github-forced';
  job.phase = 'start';
  if (opts.isCancelled()) return { kind: 'done', snapshot: opts.snapshot() };
  if (job.abort.signal.aborted) return { kind: 'done', snapshot: opts.markCancelled() };
  const result = await postNodeReleaseUpgrade({
    forward: opts.forward,
    req: opts.req,
    nodeId: job.nodeId,
    version: job.version,
    requireFastSource: opts.requireFastSource,
    signal: job.abort.signal,
    timeoutMs: opts.timeoutMs,
  });
  if (opts.isCancelled() || result.detail === 'cancelled') {
    return { kind: 'done', snapshot: opts.snapshot() };
  }
  if (job.abort.signal.aborted) return { kind: 'done', snapshot: opts.markCancelled() };
  if (result.kind === 'accepted') {
    job.state = 'handed-off';
    job.error = null;
    return { kind: 'done', snapshot: opts.snapshot() };
  }
  if (result.kind === 'busy') {
    return { kind: 'done', snapshot: opts.fail(result.detail) };
  }
  if (result.kind === 'rejected' && opts.requireFastSource) {
    const hard = /UPGRADE_NOT_ALLOWED|UPGRADE_SIGNATURE_REQUIRED/.test(result.detail);
    if (hard) return { kind: 'done', snapshot: opts.fail(result.detail) };
  }
  return { kind: 'fallback', detail: summarizeChannelFailure(job.channel, result.detail) };
}

export function stepFromSnapshot<T>(
  state: string,
  channel: RemoteUpgradeChannel,
  snapshot: T,
  error: string | null
): DeliveryStepResult<T> {
  if (state === 'cancelled' || state === 'handed-off') return { kind: 'done', snapshot };
  return { kind: 'fallback', detail: summarizeChannelFailure(channel, error ?? 'failed') };
}

async function readJsonObject(res: Response): Promise<Record<string, unknown> | null> {
  const text = await consumeBoundedBody(res);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 非 JSON
  }
  return null;
}
