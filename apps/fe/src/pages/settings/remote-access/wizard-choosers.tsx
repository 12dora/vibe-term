// 远程访问向导的两张单选卡：连接方式（隧道 / 直接连接）与隧道类型（临时 / 命名）。

import { Cloud, Server, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChoiceCard } from './choice-card';
import type { ConnectionPath, WizardMode } from './tunnel-model';

export function PathChooser({
  selected,
  locked,
  disabled,
  onSelect,
}: {
  selected: ConnectionPath | null;
  /** 已经建过隧道：要改走直接连接必须先「移除」，这里只展示当前路径。 */
  locked: boolean;
  disabled: boolean;
  onSelect: (path: ConnectionPath) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3 sm:grid-cols-2"
      role="radiogroup"
      aria-label={t('settings.remoteAccess.steps.path.title')}
      data-testid="remote-access-path-chooser"
    >
      <ChoiceCard
        group="path"
        value="tunnel"
        icon={<Cloud className="size-4" />}
        selected={selected === 'tunnel'}
        disabled={disabled || locked}
        onSelect={onSelect}
      />
      <ChoiceCard
        group="path"
        value="direct"
        icon={<Server className="size-4" />}
        selected={selected === 'direct'}
        disabled={disabled || locked}
        onSelect={onSelect}
      />
    </div>
  );
}

export function ModeChooser({
  selected,
  locked,
  disabled,
  onSelect,
}: {
  selected: WizardMode;
  /** 已经建过隧道：换类型必须先「移除」，这里只展示当前类型。 */
  locked: boolean;
  disabled: boolean;
  onSelect: (mode: WizardMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3 sm:grid-cols-2"
      role="radiogroup"
      aria-label={t('settings.remoteAccess.steps.mode.title')}
      data-testid="remote-access-mode-chooser"
    >
      <ChoiceCard
        group="mode"
        value="quick"
        icon={<Zap className="size-4" />}
        selected={selected === 'quick'}
        disabled={disabled || locked}
        onSelect={onSelect}
      />
      <ChoiceCard
        group="mode"
        value="named"
        icon={<Cloud className="size-4" />}
        selected={selected === 'named'}
        disabled={disabled || locked}
        onSelect={onSelect}
      />
    </div>
  );
}
