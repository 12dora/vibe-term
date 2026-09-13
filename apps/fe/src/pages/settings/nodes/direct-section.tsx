// 直连插件区：安装（下载 `native/`）和启用（`VIBETERM_DIRECT_ENABLED`）是两件独立的事——装好的插件
// 可以先关着，关掉也不必删文件，所以按钮管安装 / 删除，开关管启用 / 停用，且开关只在装好之后出现。
// 四个动作都要重启网关才生效，横幅与重启入口由调用方给出。

import { LocalApiError } from '@vibeterm/api-client/local/local-api';
import type {
  LocalDirectAction,
  LocalDirectResponse,
  LocalDirectStatus,
} from '@vibeterm/api-client/local/types';
import { errorMessage } from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import { Switch } from '@vibeterm/ui/switch';
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
  const detail = errorMessage(error).trim();
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

/** 一句状态文本：不支持 → 未安装 → 已安装（有版本就只报版本）。启用与否交给同一行的开关。 */
export function directStatusText(
  direct: LocalDirectStatus,
  t: Translate
): { state: string; text: string } {
  if (!direct.supported) {
    return { state: 'unsupported', text: t('nodes.machine.directUnsupported') };
  }
  if (!direct.installed) {
    return { state: 'not-installed', text: t('nodes.machine.directNotInstalled') };
  }
  return {
    state: 'installed',
    text: direct.version
      ? t('nodes.machine.directVersion', { version: direct.version })
      : t('nodes.machine.directInstalled'),
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
  const { supported, installed } = direct;
  const status = directStatusText(direct, t);
  return (
    <Row label={t('nodes.machine.direct')}>
      {supported && installed && (
        <DirectSwitch enabled={direct.enabled} busy={busy} onAction={onAction} />
      )}
      <span
        className={status.state === 'installed' ? 'text-muted-foreground' : undefined}
        data-testid="local-machine-direct-status"
        data-direct-state={status.state}
      >
        {status.text}
      </span>
      {supported && (
        <DirectAction installed={installed} busy={busy} pending={pending} onAction={onAction} />
      )}
      {error && (
        <p className="w-full text-destructive" data-testid="local-machine-direct-error">
          {error}
        </p>
      )}
    </Row>
  );
}

/** 装好之后才有的启用开关：没装就只给「安装」，不摆一个拨不动的开关。 */
function DirectSwitch({
  enabled,
  busy,
  onAction,
}: {
  enabled: boolean;
  busy: boolean;
  onAction: (action: LocalDirectAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <label
      className="flex items-center gap-1.5 text-muted-foreground"
      htmlFor="local-machine-direct-switch"
    >
      {t('nodes.machine.directEnable')}
      <Switch
        id="local-machine-direct-switch"
        size="sm"
        checked={enabled}
        disabled={busy}
        onCheckedChange={(checked) => onAction(checked ? 'enable' : 'disable')}
        data-testid="local-machine-direct-switch"
      />
    </label>
  );
}

/** 当前状态只对应一个动作：没装给「安装」，装了给「删除」。 */
function DirectAction({
  installed,
  busy,
  pending,
  onAction,
}: {
  installed: boolean;
  busy: boolean;
  pending: LocalDirectAction | null;
  onAction: (action: LocalDirectAction) => void;
}) {
  const { t } = useTranslation();
  const action = installed ? 'remove' : 'install';
  const Icon = installed ? Trash2 : Download;
  return (
    <Button
      type="button"
      size="xs"
      variant={installed ? 'ghost' : 'outline'}
      disabled={busy}
      onClick={() => onAction(action)}
      data-testid={`local-machine-direct-${action}`}
    >
      {pending === action ? <Loader2 className="animate-spin" /> : <Icon />}
      {t(installed ? 'nodes.machine.directRemove' : 'nodes.machine.directInstall')}
    </Button>
  );
}

export function RemoveConfirm({
  open,
  relayMode = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** 走中继的机器不能被告知「会话会继续经 Hub 中转」：它根本没有 Hub。 */
  relayMode?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      title={t('nodes.machine.directRemoveConfirm.title')}
      cancelLabel={t('nodes.machine.directRemoveConfirm.cancel')}
      confirmLabel={t('nodes.machine.directRemoveConfirm.confirm')}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId="local-machine-direct-remove-confirm"
      confirmTestId="local-machine-direct-remove-confirm-ok"
    >
      {t(
        relayMode
          ? 'nodes.machine.directRemoveConfirm.descriptionRelay'
          : 'nodes.machine.directRemoveConfirm.description'
      )}
    </ConfirmDialog>
  );
}
