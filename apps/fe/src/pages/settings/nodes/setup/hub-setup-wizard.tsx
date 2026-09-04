// standalone 实例的设置向导：三条互斥路径——把本机变成 hub、加入已有 hub、把本机变成中继。
//
// 三条路径都会写 env 并重启网关，因此向导只在 `role === 'standalone'` 下出现；
// 一旦成功，本页所在的 SPA 会在重启完成后整页跳到 `/login`（纯中继除外：那一档没有网页）。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Reveal } from '@tmex/ui/motion';
import { Radio, Server, Share2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SetupIntent } from '../membership/intent';
import { BecomeHubForm } from './become-hub-form';
import { BecomeRelayForm } from './become-relay-form';
import { JoinHubForm } from './join-hub-form';

export type SetupPath = SetupIntent;

export interface HubSetupWizardProps {
  localStatus: LocalStatusResponse | null;
  client?: ApiClient;
  /** 预选路径；默认不选，先让用户读完两条路径的说明。 */
  initialPath?: SetupPath | null;
  origin?: string | null;
  hostname?: string | null;
  onRestarted?: () => void;
}

export function HubSetupWizard({
  localStatus,
  client = defaultApiClient,
  initialPath = null,
  origin,
  hostname,
  onRestarted,
}: HubSetupWizardProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState<SetupPath | null>(initialPath);

  if (!localStatus) {
    return (
      <p className="p-2 text-xs text-muted-foreground" data-testid="setup-wizard-loading">
        {t('common.loading')}
      </p>
    );
  }

  // 已经在 mesh 里的实例没有向导可言：角色切换走 `hub leave` / Nodes 管理面。
  if (localStatus.role !== 'standalone') return null;

  return (
    <div className="space-y-4" data-testid="hub-setup-wizard">
      <Card className="border-0 ring-0">
        <CardHeader>
          <CardTitle>{t('nodes.setup.title')}</CardTitle>
          <CardDescription>{t('nodes.setup.intro')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('nodes.setup.introDetail')}</p>
          <div
            className="grid gap-3 sm:grid-cols-3"
            role="radiogroup"
            aria-label={t('nodes.setup.title')}
          >
            <PathCard
              testId="setup-path-become-hub"
              icon={<Server className="size-4" />}
              title={t('nodes.setup.path.becomeHub.title')}
              description={t('nodes.setup.path.becomeHub.description')}
              selected={path === 'become-hub'}
              onSelect={() => setPath('become-hub')}
            />
            <PathCard
              testId="setup-path-join-hub"
              icon={<Share2 className="size-4" />}
              title={t('nodes.setup.path.joinHub.title')}
              description={t('nodes.setup.path.joinHub.description')}
              selected={path === 'join-hub'}
              onSelect={() => setPath('join-hub')}
            />
            <PathCard
              testId="setup-path-become-relay"
              icon={<Radio className="size-4" />}
              title={t('nodes.setup.path.becomeRelay.title')}
              description={t('nodes.setup.path.becomeRelay.description')}
              selected={path === 'become-relay'}
              onSelect={() => setPath('become-relay')}
            />
          </div>
        </CardContent>
      </Card>

      {/* 选完路径下方才长出表单：按 path 换 key，两条路径互切时也重放一次入场。 */}
      {path && (
        <Reveal key={path}>
          {path === 'become-hub' ? (
            <BecomeHubForm
              localStatus={localStatus}
              client={client}
              origin={origin}
              {...(onRestarted ? { onRestarted } : {})}
            />
          ) : path === 'become-relay' ? (
            <BecomeRelayForm
              localStatus={localStatus}
              client={client}
              origin={origin}
              {...(onRestarted ? { onRestarted } : {})}
            />
          ) : (
            <JoinHubForm
              localStatus={localStatus}
              client={client}
              hostname={hostname}
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
  onSelect,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      data-testid={testId}
      data-selected={selected ? 'true' : 'false'}
      className={`flex cursor-pointer flex-col gap-1.5 rounded-xl p-3 text-left ring-1 transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none ${
        selected ? 'bg-primary/5 ring-primary' : 'bg-card ring-foreground/10 hover:bg-muted/50'
      }`}
    >
      <input
        type="radio"
        name="hub-setup-path"
        className="sr-only"
        checked={selected}
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
