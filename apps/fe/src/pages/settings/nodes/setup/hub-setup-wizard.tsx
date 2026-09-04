// standalone 实例的设置向导：四条互斥路径——把本机变成 Hub、加入已有 Hub、加入已有中继、
// 把本机变成中继。
//
// 三条路径都会写 env 并重启网关，因此向导只在 `role === 'standalone'` 下出现；
// 一旦成功，本页所在的 SPA 会在重启完成后整页跳到 `/login`（纯中继除外：那一档没有网页）。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { LocalStatusResponse, SetupRelayRole } from '@tmex/api-client/local/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Reveal } from '@tmex/ui/motion';
import { Radio, Server, Share2, Waypoints } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SetupIntent } from '../membership/intent';
import { BecomeHubForm } from './become-hub-form';
import { BecomeRelayForm } from './become-relay-form';
import { JoinHubForm } from './join-hub-form';
import { JoinRelayForm } from './join-relay-form';
import { useSetupCommitted } from './setup-transition';

export type SetupPath = SetupIntent;

export interface HubSetupWizardProps {
  localStatus: LocalStatusResponse | null;
  client?: ApiClient;
  /** 预选路径；默认不选，先让用户读完四条路径的说明。 */
  initialPath?: SetupPath | null;
  /** 「本机作为中继」表单的预选角色（跨重启记号带来的）。 */
  initialRelayRole?: SetupRelayRole;
  origin?: string | null;
  hostname?: string | null;
  onRestarted?: () => void;
}

export function HubSetupWizard({
  localStatus,
  client = defaultApiClient,
  initialPath = null,
  initialRelayRole,
  origin,
  hostname,
  onRestarted,
}: HubSetupWizardProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState<SetupPath | null>(initialPath);
  // 已经有一路提交成功：换路径会把结果面板与重启进度一起卸掉，锁住不让换。
  const committed = useSetupCommitted();

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
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            role="radiogroup"
            aria-label={t('nodes.setup.title')}
          >
            <PathCard
              testId="setup-path-become-hub"
              icon={<Server className="size-4" />}
              title={t('nodes.setup.path.becomeHub.title')}
              description={t('nodes.setup.path.becomeHub.description')}
              selected={path === 'become-hub'}
              disabled={committed}
              onSelect={() => setPath('become-hub')}
            />
            <PathCard
              testId="setup-path-join-hub"
              icon={<Share2 className="size-4" />}
              title={t('nodes.setup.path.joinHub.title')}
              description={t('nodes.setup.path.joinHub.description')}
              selected={path === 'join-hub'}
              disabled={committed}
              onSelect={() => setPath('join-hub')}
            />
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
          ) : path === 'join-relay' ? (
            <JoinRelayForm
              localStatus={localStatus}
              client={client}
              hostname={hostname}
              {...(onRestarted ? { onRestarted } : {})}
            />
          ) : path === 'become-relay' ? (
            /* 跨重启记号可能晚于本机状态才读到：`initialRole` 只在挂载时进 `useState`，
               必须换 key 重挂，否则恢复出来的「纯中继」会被默认的「中继兼节点」吞掉。 */
            <BecomeRelayForm
              key={initialRelayRole ?? 'relay,node'}
              localStatus={localStatus}
              client={client}
              origin={origin}
              {...(initialRelayRole ? { initialRole: initialRelayRole } : {})}
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
      className={`flex flex-col gap-1.5 rounded-xl p-3 text-left ring-1 transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${selected ? 'bg-primary/5 ring-primary' : 'bg-card ring-foreground/10 hover:bg-muted/50'}`}
    >
      <input
        type="radio"
        name="hub-setup-path"
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
