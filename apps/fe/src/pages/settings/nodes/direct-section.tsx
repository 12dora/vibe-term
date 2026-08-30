// 直连插件区：安装（下载 `native/`）和启用（`TMEX_DIRECT_ENABLED`）是两件独立的事——装好的插件
// 可以先关着，关掉也不必删文件，两者只在「未安装时开关不可用」上耦合，所以按钮管安装 / 删除，
// 开关管启用 / 停用。四个动作都要重启网关才生效，横幅与重启入口由调用方给出。

import { LocalApiError } from '@tmex/api-client/local/local-api';
import type {
  LocalDirectAction,
  LocalDirectResponse,
  LocalDirectStatus,
} from '@tmex/api-client/local/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Download, Loader2, Trash2 } from 'lucide-react';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Row } from './copy-feedback';

/** 只取 `LocalApi` 的直连那一面，测试注入假实现时不必凑出整个客户端。 */
export interface DirectApi {
  setDirect(action: LocalDirectAction): Promise<LocalDirectResponse>;
}

/** 这些错误码的 `message` 才是诊断信息（下载失败的原因、加载失败的 dlopen 报错）。 */
const DIRECT_ERROR_KEY: Record<string, string> = {
  direct_unsupported: 'nodes.machine.directErrorUnsupported',
  direct_download_failed: 'nodes.machine.directErrorDownloadFailed',
  direct_not_installed: 'nodes.machine.directErrorNotInstalled',
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function describeDirectError(t: Translate, error: unknown): string {
  const base = t(
    (error instanceof LocalApiError && DIRECT_ERROR_KEY[error.code]) || 'nodes.machine.directFailed'
  );
  const detail = (error instanceof Error ? error.message : String(error)).trim();
  const code = error instanceof LocalApiError ? error.code : '';
  if (!detail || detail === code) return base;
  return t('nodes.machine.directErrorDetail', { base, detail });
}

export interface DirectMutationState {
  pending: LocalDirectAction | null;
  /** 删除插件前的二次确认。 */
  confirmingRemove: boolean;
}

export interface DirectMutationCallbacks {
  onResult: (result: LocalDirectResponse) => void;
  onError: (error: unknown) => void;
  onRefresh: () => void;
}

/**
 * 四个动作共用一把锁：安装要下载最多 60 s，期间再点删除 / 拨开关只会让 `native/` 和 env
 * 互相打架。状态放在可订阅的控制器里而不是组件 state，锁与确认流程才能脱离 DOM 直接测。
 */
export class DirectMutationController {
  private state: DirectMutationState = { pending: null, confirmingRemove: false };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: DirectApi,
    private readonly readCallbacks: () => DirectMutationCallbacks
  ) {}

  snapshot = (): DirectMutationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return this.state.pending !== null;
  }

  run = async (action: LocalDirectAction): Promise<void> => {
    if (this.busy || this.state.confirmingRemove) return;
    await this.perform(action);
  };

  requestRemove = (): void => {
    if (this.busy || this.state.confirmingRemove) return;
    this.update({ confirmingRemove: true });
  };

  confirmRemove = async (): Promise<void> => {
    if (!this.state.confirmingRemove) return;
    this.update({ confirmingRemove: false });
    if (this.busy) return;
    await this.perform('remove');
  };

  cancelRemove = (): void => {
    if (this.state.confirmingRemove) this.update({ confirmingRemove: false });
  };

  private async perform(action: LocalDirectAction): Promise<void> {
    this.update({ pending: action });
    try {
      const result = await this.api.setDirect(action);
      this.readCallbacks().onResult(result);
    } catch (error) {
      this.readCallbacks().onError(error);
    } finally {
      this.update({ pending: null });
      // 成功要拿到权威状态，失败也要——下载失败时 `native/` 可能已被清干净。
      this.readCallbacks().onRefresh();
    }
  }

  private update(patch: Partial<DirectMutationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export function useDirectMutations(api: DirectApi, callbacks: DirectMutationCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const controller = useMemo(
    () => new DirectMutationController(api, () => callbacksRef.current),
    [api]
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );

  return {
    ...state,
    busy: state.pending !== null,
    /** `remove` 先走二次确认，其余动作直接发。 */
    dispatch: (action: LocalDirectAction) => {
      if (action === 'remove') controller.requestRemove();
      else void controller.run(action);
    },
    confirmRemove: () => void controller.confirmRemove(),
    cancelRemove: controller.cancelRemove,
  };
}

export function DirectSection({
  direct,
  busy,
  pending,
  error,
  onAction,
}: {
  direct: LocalDirectStatus;
  busy: boolean;
  pending: LocalDirectAction | null;
  error: string | null;
  onAction: (action: LocalDirectAction) => void;
}) {
  const { t } = useTranslation();
  const { supported, installed, enabled, capable, version } = direct;
  const primary = installed ? 'remove' : 'install';
  const PrimaryIcon = installed ? Trash2 : Download;
  const installedLabel = installed
    ? version
      ? t('nodes.machine.directInstalledVersion', { version })
      : t('nodes.machine.directInstalled')
    : t('nodes.machine.directNotInstalled');
  return (
    <>
      <Row label={t('nodes.machine.direct')}>
        <div className="flex flex-wrap items-center gap-2">
          {supported ? (
            <>
              <DirectBadge id="supported">{t('nodes.machine.directSupported')}</DirectBadge>
              <DirectBadge id="installed">{installedLabel}</DirectBadge>
              {installed && capable && (
                <DirectBadge id="active">{t('nodes.machine.directActive')}</DirectBadge>
              )}
              {installed && !enabled && (
                <DirectBadge id="disabled">{t('nodes.machine.directDisabled')}</DirectBadge>
              )}
            </>
          ) : (
            <DirectBadge id="unsupported">{t('nodes.machine.directUnsupported')}</DirectBadge>
          )}
          <Button
            type="button"
            size="xs"
            variant={installed ? 'destructive' : 'outline'}
            disabled={!supported || busy}
            onClick={() => onAction(primary)}
            data-testid={`local-machine-direct-${primary}`}
          >
            {pending === primary ? <Loader2 className="animate-spin" /> : <PrimaryIcon />}
            {t(installed ? 'nodes.machine.directRemove' : 'nodes.machine.directInstall')}
          </Button>
        </div>
      </Row>

      <Row label={t('nodes.machine.directSwitch')}>
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            checked={installed && enabled}
            disabled={!supported || !installed || busy}
            onCheckedChange={(checked) => onAction(checked ? 'enable' : 'disable')}
            data-testid="local-machine-direct-switch"
          />
          {supported && !installed && (
            <span className="text-xs text-muted-foreground" data-testid="local-machine-direct-hint">
              {t('nodes.machine.directSwitchHint')}
            </span>
          )}
        </div>
      </Row>

      {error && (
        <p className="text-xs text-destructive" data-testid="local-machine-direct-error">
          {error}
        </p>
      )}
    </>
  );
}

function DirectBadge({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Badge variant="outline" data-testid={`local-machine-direct-${id}`}>
      {children}
    </Badge>
  );
}

export function RemoveConfirm({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <AlertDialog open onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent data-testid="local-machine-direct-remove-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.machine.directRemoveConfirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('nodes.machine.directRemoveConfirm.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onCancel}
            data-testid="local-machine-direct-remove-confirm-cancel"
          >
            {t('nodes.machine.directRemoveConfirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            data-testid="local-machine-direct-remove-confirm-ok"
          >
            {t('nodes.machine.directRemoveConfirm.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
