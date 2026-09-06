import type { InternalHttpForwarder } from '../mesh/mesh-agent-bridge';
import type { PaneInfo } from '../tmux-client/capture-history';
import type { PaneGrantRef, PaneGrantSource } from './pane-grant/types';
import type { PaneSnapshotLookup, SnapshotPaneContext } from './tools/pane-info';
import type { TerminalRuntimeLike } from './tools/terminal-context';

export interface RemotePaneInfoPayload {
  info: PaneInfo;
  snapshot: SnapshotPaneContext | null;
  snapshotExists: boolean;
}

export class RemotePaneUnreachableError extends Error {
  readonly code = 'NODE_UNREACHABLE';
  readonly nodeId: string;

  constructor(nodeId: string, cause?: unknown) {
    super(`NODE_UNREACHABLE: remote node ${nodeId} is not reachable`);
    this.name = 'RemotePaneUnreachableError';
    this.nodeId = nodeId;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** 目标节点拒收授权的两个码：缺授权与授权无效，都要重签。 */
function isGrantRejection(code: string): boolean {
  return code === 'PANE_GRANT_REQUIRED' || code === 'PANE_GRANT_INVALID';
}

export class RemotePaneRuntime implements TerminalRuntimeLike {
  private lastSnapshot: { paneId: string; lookup: PaneSnapshotLookup } | null = null;

  constructor(
    private readonly nodeId: string,
    private readonly deviceId: string,
    private readonly forward: InternalHttpForwarder,
    private readonly grants?: PaneGrantSource
  ) {}

  async sendInput(paneId: string, data: string): Promise<void> {
    const payload = await this.rpc<{ ok?: boolean }>('/api/mesh-internal/tmux/send-input', {
      deviceId: this.deviceId,
      paneId,
      data,
    });
    if (!payload.ok) {
      throw new Error('remote send-input failed');
    }
  }

  async capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string> {
    const payload = await this.rpc<{ text?: string }>('/api/mesh-internal/tmux/capture', {
      deviceId: this.deviceId,
      paneId,
      ...(opts?.historyLines !== undefined ? { historyLines: opts.historyLines } : {}),
    });
    return payload.text ?? '';
  }

  async getPaneInfo(paneId: string): Promise<PaneInfo> {
    const payload = await this.fetchPaneInfo(paneId);
    return payload.info;
  }

  findPaneInSnapshot(paneId: string): PaneSnapshotLookup {
    if (this.lastSnapshot?.paneId === paneId) {
      return this.lastSnapshot.lookup;
    }
    return { found: false, snapshotExists: false };
  }

  private async fetchPaneInfo(paneId: string): Promise<RemotePaneInfoPayload> {
    const payload = await this.rpc<RemotePaneInfoPayload>('/api/mesh-internal/tmux/pane-info', {
      deviceId: this.deviceId,
      paneId,
    });
    this.lastSnapshot = {
      paneId,
      lookup: payload.snapshot
        ? { found: true, context: payload.snapshot }
        : { found: false, snapshotExists: Boolean(payload.snapshotExists) },
    };
    return payload;
  }

  private async rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const grant = (await this.grants?.load()) ?? null;
    const response = await this.send(path, body, grant);
    if (response.status !== 403) {
      return this.readPayload<T>(response);
    }
    const code = await readErrorMessage(response);
    if (!isGrantRejection(code)) {
      throw new Error(code);
    }
    // 目标节点不认这张：标记待重签，若别的请求刚补过一张就地再试一次。
    this.grants?.reject();
    const retry = (await this.grants?.load()) ?? null;
    if (!retry || retry.grantId === grant?.grantId) {
      throw new Error(code);
    }
    return this.readPayload<T>(await this.send(path, body, retry));
  }

  private async send(
    path: string,
    body: Record<string, unknown>,
    grant: PaneGrantRef | null
  ): Promise<Response> {
    try {
      return await this.forward(this.nodeId, path, grant ? { ...body, grant } : body);
    } catch (error) {
      if (error instanceof RemotePaneUnreachableError) {
        throw error;
      }
      throw new RemotePaneUnreachableError(this.nodeId, error);
    }
  }

  private async readPayload<T>(response: Response): Promise<T> {
    if (response.status === 503) {
      throw new RemotePaneUnreachableError(this.nodeId);
    }
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    return (await response.json()) as T;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return body.error ?? body.code ?? `remote pane rpc failed (${response.status})`;
  } catch {
    return `remote pane rpc failed (${response.status})`;
  }
}
