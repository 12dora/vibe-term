// 未受保护时的公网暴露警示：一条 destructive 提示 + 一个显式确认勾选。
//
// 确认是**逐个动作**的：每条警示自带一个勾选框，勾选只对紧挨着它的那个动作生效，
// 动作发出后立即作废，保护状态或隧道运行态一变也作废。
// 只有勾上之后动作才会带 `acknowledgeExposure`，否则后端回 409 `exposure_ack_required`。

import type { TunnelActionRequest, TunnelStatusResponse } from '@tmex/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SetupNotice } from '../nodes/setup/form-parts';
import { isExposingAction, isTunnelRunning, withExposureAck } from './tunnel-model';

export interface ExposureState {
  /** 既没有启用登录，也没有生效的 Cloudflare Access。 */
  unprotected: boolean;
  /** 后端已经回过 `exposure_ack_required`。 */
  ackRequired: boolean;
  /**
   * 被 409 拒掉的那个动作对应的勾选框 id。后端判定暴露的口径比前端宽（自启动超时留下的
   * `error`、探测超时的接管隧道都算暴露），本地判定说「不用确认」时同样会吃 409；
   * 这条兜底保证被拒的那个动作旁边一定会出现勾选框，否则重试永远带不上确认。
   */
  ackRequiredId: string | null;
  /** 当前被勾上的那条警示（用勾选框 id 标识）；同一时刻至多一条。 */
  ackedId: string | null;
  setAckedId: (id: string | null) => void;
}

/** 每条警示的勾选框 id：既是 DOM id，也是「这次确认属于哪个动作」的标识。 */
export const EXPOSURE_ACK = {
  start: 'remote-access-start-ack',
  quick: 'remote-access-quick-ack',
  create: 'remote-access-create-ack',
  autoStart: 'remote-access-auto-start-ack',
  accessMode: 'remote-access-access-mode-ack',
  accessEnforce: 'remote-access-access-drop-ack',
  accessRemove: 'remote-access-access-remove-ack',
} as const;

/** 动作 → 勾选框 id：409 回来时据此找到该由哪条警示接住这次确认。 */
const ACK_ID_BY_ACTION: Partial<Record<TunnelActionRequest['action'], string>> = {
  start: EXPOSURE_ACK.start,
  quick_start: EXPOSURE_ACK.quick,
  create: EXPOSURE_ACK.create,
  set_auto_start: EXPOSURE_ACK.autoStart,
  set_access_mode: EXPOSURE_ACK.accessMode,
  set_access_enforce: EXPOSURE_ACK.accessEnforce,
  remove_access: EXPOSURE_ACK.accessRemove,
};

export function exposureAckIdOf(req: TunnelActionRequest | null | undefined): string | null {
  if (!req || !isExposingAction(req)) return null;
  return ACK_ID_BY_ACTION[req.action] ?? null;
}

export type ExposureVariant = 'full' | 'compact' | 'drop';

const WARNING_KEY: Record<ExposureVariant, string> = {
  full: 'settings.remoteAccess.exposure.warning',
  compact: 'settings.remoteAccess.exposure.warningShort',
  drop: 'settings.remoteAccess.exposure.dropWarning',
};

/** 后端刚因为这个动作回过 409：这条警示无论本地判定如何都必须出现。 */
function ackForced(exposure: ExposureState, id: string): boolean {
  return exposure.ackRequiredId !== null && exposure.ackRequiredId === id;
}

/**
 * 这一档警示要不要出现。`drop` 用于「关掉令牌校验 / 删掉 Access 应用」——此刻保护还在
 * （`unprotected` 为假），但动作本身会把它拿掉，所以只要调用方判定会掉保护就无条件渲染。
 * 传了 `id` 时，被 409 拒掉的那个动作一律出现。
 */
export function exposureShown(
  exposure: ExposureState,
  variant: ExposureVariant,
  id?: string
): boolean {
  if (id !== undefined && ackForced(exposure, id)) return true;
  // 已经知道 409 属于哪个动作时，只有那一条该亮；归属不明（旧后端的 job 错误）才全体兜底。
  const unowned = exposure.ackRequired && exposure.ackRequiredId === null;
  return variant === 'drop' || exposure.unprotected || unowned;
}

export interface ExposureAck {
  /** 勾选框 id，同时是这次确认的归属标识。 */
  id: string;
  /** 对应的警示是否真的渲染在页面上。 */
  shown: boolean;
  /** 这次显示是后端 409 逼出来的（本地判定可能认为不必确认）。 */
  ackRequired: boolean;
  /** 警示在页面上且用户勾了它。 */
  checked: boolean;
  set: (next: boolean) => void;
  /** 带上这一次的确认发出，并立即清掉勾选——确认只对这一个动作有效。 */
  submit: (run: (req: TunnelActionRequest) => void, req: TunnelActionRequest) => void;
}

/**
 * 把某条警示的勾选状态绑到一个动作上：`shown` 由调用方按自己的渲染条件给出，
 * 后端已经因为这个动作回过 409 时无条件显示——本地判定漏了，重试才有地方勾。
 */
export function exposureAck(exposure: ExposureState, id: string, shown: boolean): ExposureAck {
  const ackRequired = ackForced(exposure, id);
  const visible = shown || ackRequired;
  const checked = visible && exposure.ackedId === id;
  return {
    id,
    shown: visible,
    ackRequired,
    checked,
    set: (next) => exposure.setAckedId(next ? id : null),
    submit: (run, req) => {
      run(withExposureAck(req, checked));
      exposure.setAckedId(null);
    },
  };
}

/**
 * 「当前保护状态 + 隧道是否在跑」的指纹。这两样一变，之前那次确认针对的场景就不存在了，
 * 标签层据此把勾选作废（如为启动隧道勾的确认，不能在隧道停掉后还留着）。
 */
export function protectionSnapshot(status: TunnelStatusResponse): string {
  return `${status.exposureProtected}:${isTunnelRunning(status)}`;
}

/** 只有 `ack` 传进来时才渲染勾选框；纯提示（如隧道类型步上方那条）不带勾选。 */
export function ExposureWarning({
  exposure,
  ack,
  testId,
  variant = 'full',
}: {
  exposure: ExposureState;
  ack?: ExposureAck;
  testId: string;
  variant?: ExposureVariant;
}) {
  const { t } = useTranslation();
  if (!(ack ? ack.shown : exposureShown(exposure, variant))) return null;
  // 「请先勾选」只挂在被拒的那个动作旁边；归属不明时退回全局。
  const ackRequiredHere =
    exposure.ackRequired && (exposure.ackRequiredId === null || ack?.ackRequired === true);

  return (
    <SetupNotice tone="error" testId={testId}>
      <p>{t(WARNING_KEY[variant])}</p>
      {ackRequiredHere && !ack?.checked && (
        <p data-testid={`${testId}-required`}>{t('settings.remoteAccess.exposure.ackRequired')}</p>
      )}
      {ack && (
        <label className="flex items-center gap-1.5 font-medium" htmlFor={ack.id}>
          <input
            id={ack.id}
            type="checkbox"
            className="size-3.5 shrink-0 accent-current"
            checked={ack.checked}
            onChange={(event) => ack.set(event.target.checked)}
            data-testid={`${testId}-ack`}
          />
          {t('settings.remoteAccess.exposure.acknowledge')}
        </label>
      )}
      {variant === 'full' && (
        <Link className="underline underline-offset-4" to="?tab=nodes">
          {t('settings.remoteAccess.exposure.enableLogin')}
        </Link>
      )}
    </SetupNotice>
  );
}
