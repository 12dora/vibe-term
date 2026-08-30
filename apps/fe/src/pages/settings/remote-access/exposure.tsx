// 未受保护时的公网暴露警示：一条 destructive 提示 + 一个显式确认勾选。
//
// 确认状态放在标签层，警示会在方式步骤上方与每个启动 / 创建动作旁重复出现，勾一次全部生效；
// 只有勾上之后动作才会带 `acknowledgeExposure`，否则后端回 409 `exposure_ack_required`。

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SetupNotice } from '../nodes/setup/form-parts';

export interface ExposureState {
  /** 既没有启用登录，也没有生效的 Cloudflare Access。 */
  unprotected: boolean;
  acknowledged: boolean;
  setAcknowledged: (next: boolean) => void;
  /** 后端已经回过 `exposure_ack_required`。 */
  ackRequired: boolean;
}

const WARNING_KEY = {
  full: 'settings.remoteAccess.exposure.warning',
  compact: 'settings.remoteAccess.exposure.warningShort',
  drop: 'settings.remoteAccess.exposure.dropWarning',
} as const;

/**
 * `drop` 用于「关掉令牌校验 / 删掉 Access 应用」——此刻保护还在（`unprotected` 为假），
 * 但动作本身会把它拿掉，所以这一档无条件渲染。
 */
export function ExposureWarning({
  exposure,
  id,
  testId,
  variant = 'full',
}: {
  exposure: ExposureState;
  /** 勾选框的 id，同一页面里多处渲染必须各不相同。 */
  id: string;
  testId: string;
  variant?: 'full' | 'compact' | 'drop';
}) {
  const { t } = useTranslation();
  if (variant !== 'drop' && !exposure.unprotected && !exposure.ackRequired) return null;

  return (
    <SetupNotice tone="error" testId={testId}>
      <p>{t(WARNING_KEY[variant])}</p>
      {exposure.ackRequired && !exposure.acknowledged && (
        <p data-testid={`${testId}-required`}>{t('settings.remoteAccess.exposure.ackRequired')}</p>
      )}
      <label className="flex items-center gap-1.5 font-medium" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="size-3.5 shrink-0 accent-current"
          checked={exposure.acknowledged}
          onChange={(event) => exposure.setAcknowledged(event.target.checked)}
          data-testid={`${testId}-ack`}
        />
        {t('settings.remoteAccess.exposure.acknowledge')}
      </label>
      {variant === 'full' && (
        <Link className="underline underline-offset-4" to="?tab=nodes">
          {t('settings.remoteAccess.exposure.enableLogin')}
        </Link>
      )}
    </SetupNotice>
  );
}
