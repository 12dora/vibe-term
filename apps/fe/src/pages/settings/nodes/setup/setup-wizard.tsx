// standalone 实例的设置向导：两条互斥路径——加入已有中继、把本机变成中继。
//
// 两条路径都会写 env 并重启网关，因此向导只在 `role === 'standalone'` 下出现；
// 一旦成功，本页所在的 SPA 会在重启完成后整页跳到 `/login`（纯中继除外：那一档没有网页）。

import { type ApiClient, defaultApiClient } from '@vibeterm/api-client';
import type { LocalStatusResponse, SetupRelayRole } from '@vibeterm/api-client/local/types';
import { Reveal } from '@vibeterm/ui/motion';
import { Radio, Waypoints } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SetupIntent } from '../membership/intent';
import { BecomeRelayForm } from './become-relay-form';
import { JoinRelayForm } from './join-relay-form';
import { useSetupCommitted } from './setup-transition';

export type SetupPath = SetupIntent;

export interface SetupWizardProps {
  localStatus: LocalStatusResponse | null;
  client?: ApiClient;
  /** 预选路径；默认不选，先让用户读完两条路径的说明。 */
  initialPath?: SetupPath | null;
  /** 「本机作为中继」表单的预选角色（跨重启记号带来的）。 */
  initialRelayRole?: SetupRelayRole;
  origin?: string | null;
  hostname?: string | null;
  onRestarted?: () => void;
}

export function SetupWizard({
  localStatus,
  client = defaultApiClient,
  initialPath = null,
  initialRelayRole,
  origin,
  hostname,
  onRestarted,
}: SetupWizardProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState<SetupPath | null>(initialPath);
  const committed = useSetupCommitted();

  if (!localStatus) {
    return (
      <p className="p-2 text-xs text-muted-foreground" data-testid="setup-wizard-loading">
        {t('common.loading')}
      </p>
    );
  }

  if (localStatus.role !== 'standalone') return null;

  return (
    <div className="space-y-4" data-testid="setup-wizard">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('nodes.setup.intro')}</p>
        <p className="text-xs text-muted-foreground">{t('nodes.setup.introDetail')}</p>
        <div
          className="grid gap-3 sm:grid-cols-2"
          role="radiogroup"
          aria-label={t('nodes.setup.title')}
        >
          <PathCard
            testId="setup-path-join-relay"
            icon={<Waypoints className="size-4" />}
            title={t('nodes.setup.path.joinRelay.title')}
            description={t('nodes.setup.path.joinRelay.description')}
            selected={path === 'join-relay'}
            disabled={committed}
            onSelect={() => setPath('join-relay')}
          />
          <PathCard
            testId="setup-path-become-relay"
            icon={<Radio className="size-4" />}
            title={t('nodes.setup.path.becomeRelay.title')}
            description={t('nodes.setup.path.becomeRelay.description')}
            selected={path === 'become-relay'}
            disabled={committed}
            onSelect={() => setPath('become-relay')}
          />
        </div>
      </div>

      {path && (
        <Reveal key={path}>
          {path === 'join-relay' ? (
            <JoinRelayForm
              localStatus={localStatus}
              client={client}
              hostname={hostname}
              {...(onRestarted ? { onRestarted } : {})}
            />
          ) : (
            <BecomeRelayForm
              key={initialRelayRole ?? 'relay,node'}
              localStatus={localStatus}
              client={client}
              origin={origin}
              {...(initialRelayRole ? { initialRole: initialRelayRole } : {})}
              {...(onRestarted ? { onRestarted } : {})}
            />
          )}
        </Reveal>
      )}
    </div>
  );
}

function PathCard({
  testId,
  icon,
  title,
  description,
  selected,
  disabled,
  onSelect,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      data-testid={testId}
      data-selected={selected ? 'true' : 'false'}
      className={`flex flex-col gap-1.5 rounded-xl p-3 text-left ring-1 transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${selected ? 'bg-primary/5 ring-primary' : 'bg-card ring-foreground/10 hover:bg-muted/50'}`}
    >
      <input
        type="radio"
        name="setup-path"
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </label>
  );
}
