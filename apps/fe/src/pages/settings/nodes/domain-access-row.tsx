// 网络 →「允许域名访问」：关掉后，经公开域名到达的请求只保留 Hub / 节点互联，网页与 API 停服。
//
// 关闭是自锁操作——正经该域名访问本页时，保存的下一刻连接就会断，所以关闭必须二次确认，
// 开启没有风险，直接写。状态放在可订阅的控制器里而不是组件 state，确认流程才能脱离 DOM 直接测。

import {
  type ApiClient,
  type DomainAccessPolicy,
  defaultApiClient,
  updateDomainAccess,
} from '@tmex/api-client';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { Switch } from '@tmex/ui/switch';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { DangerConfirmDialog } from '../components/danger-confirm-dialog';
import { Row } from './copy-feedback';

/** 旧节点（契约补齐之前）不下发这个字段：类型上必有、运行时未必有，读不到就整行不渲染。 */
export function readDomainAccess(status: LocalStatusResponse | null): DomainAccessPolicy | null {
  const policy = status?.domainAccess as DomainAccessPolicy | undefined;
  return policy && Array.isArray(policy.hosts) ? policy : null;
}

/** 只取域名访问那一面，测试注入假实现时不必凑出整个客户端。 */
export interface DomainAccessApi {
  update(allowed: boolean): Promise<DomainAccessPolicy>;
}

export function domainAccessApi(client: ApiClient = defaultApiClient): DomainAccessApi {
  return { update: (allowed) => updateDomainAccess(allowed, client) };
}

/** 确认框正文：正经该域名访问时多一条「本页会立即断开」的强提示。 */
export function domainAccessConfirmLines(viaDomain: boolean): string[] {
  const lines = ['nodes.machine.domainAccess.confirm.description'];
  if (viaDomain) lines.push('nodes.machine.domainAccess.confirm.viaDomain');
  return lines;
}

export interface DomainAccessState {
  pending: boolean;
  /** 等待确认的关闭操作。 */
  confirming: boolean;
  error: unknown;
}

export interface DomainAccessCallbacks {
  onResult: (policy: DomainAccessPolicy) => void;
  onRefresh: () => void;
}

export class DomainAccessController {
  private state: DomainAccessState = { pending: false, confirming: false, error: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: DomainAccessApi,
    private readonly readCallbacks: () => DomainAccessCallbacks
  ) {}

  snapshot = (): DomainAccessState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 开启直接写；关闭先登记确认。 */
  request = async (next: boolean): Promise<void> => {
    if (this.state.pending || this.state.confirming) return;
    if (!next) {
      this.update({ confirming: true, error: null });
      return;
    }
    await this.perform(true);
  };

  confirm = async (): Promise<void> => {
    if (!this.state.confirming) return;
    this.update({ confirming: false });
    if (this.state.pending) return;
    await this.perform(false);
  };

  cancel = (): void => {
    if (this.state.confirming) this.update({ confirming: false });
  };

  private async perform(allowed: boolean): Promise<void> {
    this.update({ pending: true, error: null });
    try {
      const policy = await this.api.update(allowed);
      this.readCallbacks().onResult(policy);
      this.update({ pending: false });
      this.readCallbacks().onRefresh();
    } catch (error) {
      this.update({ pending: false, error });
    }
  }

  private update(patch: Partial<DomainAccessState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function useDomainAccessController(api: DomainAccessApi, callbacks: DomainAccessCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const controller = useMemo(
    () => new DomainAccessController(api, () => callbacksRef.current),
    [api]
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  return { controller, state };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function describeDomainAccessError(t: Translate, error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error)).trim();
  return t('nodes.machine.domainAccess.failed', { detail });
}

export function DomainAccessRow({
  policy,
  api = domainAccessApi(),
  onRefresh,
}: {
  policy: DomainAccessPolicy;
  api?: DomainAccessApi;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  // 写入的返回体就是权威结果，先盖在拉到的状态上；下一份 local-status 到达（引用变了）即撤销。
  const [applied, setApplied] = useState<boolean | null>(null);
  const [seen, setSeen] = useState(policy);
  if (seen !== policy) {
    setSeen(policy);
    setApplied(null);
  }
  const { controller, state } = useDomainAccessController(api, {
    onResult: (next) => setApplied(next.allowed),
    onRefresh,
  });

  const hosts = policy.hosts.join(t('nodes.machine.domainAccess.hostSeparator'));
  const allowed = applied ?? policy.allowed;
  return (
    <>
      {/* 开关与标签同一行（与直连插件那一行同一套版式），说明另起一行占满宽度：
          窄屏下缩进到标签右侧只会把说明压成一列。 */}
      <div className="flex min-w-0 flex-col gap-1">
        <Row label={t('nodes.machine.domainAccess.label')}>
          <Switch
            size="sm"
            checked={allowed}
            disabled={state.pending || policy.hosts.length === 0}
            onCheckedChange={(next) => void controller.request(Boolean(next))}
            data-testid="local-machine-domain-access-switch"
            aria-label={t('nodes.machine.domainAccess.label')}
          />
        </Row>
        <span
          className="text-xs text-muted-foreground"
          data-testid="local-machine-domain-access-hint"
        >
          {policy.hosts.length > 0
            ? t('nodes.machine.domainAccess.description', { hosts })
            : t('nodes.machine.domainAccess.noHosts')}
        </span>
        {state.error !== null && (
          <span
            className="text-xs text-destructive"
            data-testid="local-machine-domain-access-error"
          >
            {describeDomainAccessError(t, state.error)}
          </span>
        )}
      </div>

      <DomainAccessConfirm
        open={state.confirming}
        viaDomain={policy.viaDomain}
        hosts={hosts}
        onConfirm={() => void controller.confirm()}
        onCancel={controller.cancel}
      />
    </>
  );
}

function DomainAccessConfirm({
  open,
  viaDomain,
  hosts,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  viaDomain: boolean;
  hosts: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DangerConfirmDialog
      open={open}
      title={t('nodes.machine.domainAccess.confirm.title')}
      cancelLabel={t('nodes.machine.domainAccess.confirm.cancel')}
      confirmLabel={t('nodes.machine.domainAccess.confirm.confirm')}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="local-machine-domain-access-confirm"
      confirmTestId="local-machine-domain-access-confirm-ok"
    >
      {domainAccessConfirmLines(viaDomain).map((key) => (
        <span key={key} className="mt-1 block first:mt-0">
          {t(key, { hosts })}
        </span>
      ))}
    </DangerConfirmDialog>
  );
}
