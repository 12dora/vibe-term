// 设置页「分享」标签：进行中的分享、历史与日志回放、分享设置。
// 数据与写操作在 use-share-tab.ts；回放窗按需加载（终端渲染器不该跟着这个标签一起下载）。

import { lazyChunk } from '@/lazy-chunk';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Reveal } from '@tmex/ui/motion';
import { Skeleton } from '@tmex/ui/skeleton';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { ActiveSharesTable } from './active-shares-table';
import { ShareHistoryTable } from './history-table';
import { DeleteShareConfirm, StopShareConfirm } from './share-confirms';
import { type SharePasswordDialogs, useSharePasswordDialogs } from './share-password-dialogs';
import type { ShareRow } from './share-rows';
import { ShareSettingsCard } from './share-settings-card';
import { type ShareTabModel, useShareTab } from './use-share-tab';

const ReplayViewer = lazyChunk(() => import('./replay-viewer').then((m) => m.ReplayViewer));

export function ShareTab() {
  const { t } = useTranslation();
  const model = useShareTab();
  const [stopping, setStopping] = useState<ShareRow | null>(null);
  const [deleting, setDeleting] = useState<ShareRow | null>(null);
  const [replaying, setReplaying] = useState<ShareRow | null>(null);
  const password = useSharePasswordDialogs(model);

  if (model.loading && model.active.length === 0 && model.history.length === 0) {
    return <ShareTabSkeleton />;
  }

  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-share-tab">
      <div>
        <h2 className="text-base font-medium">{t('settings.share.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('settings.share.description')}</p>
      </div>

      {model.loadError && (
        <Notice tone="error" testId="share-load-error">
          {t('settings.share.loadFailed', { message: model.loadError })}
        </Notice>
      )}
      {model.actionError && (
        <Notice tone="error" testId="share-action-error">
          {model.actionError}
        </Notice>
      )}

      <ActiveShareCard model={model} onStop={setStopping} onPasswordAction={password.open} />

      <HistoryShareCard model={model} onReplay={setReplaying} onDelete={setDeleting} />

      {model.settings && (
        <Reveal delayMs={120}>
          <ShareSettingsCard
            settings={model.settings}
            candidates={model.origins?.candidates ?? []}
            saving={model.savingSettings}
            saveError={model.saveError}
            onSave={model.saveSettings}
          />
        </Reveal>
      )}
      {model.settingsError && (
        <Notice tone="error" testId="share-settings-error">
          {t('settings.share.form.loadFailed', { message: model.settingsError })}
        </Notice>
      )}

      <StopShareConfirm
        share={stopping}
        busy={model.busyRowKey !== null}
        onCancel={() => setStopping(null)}
        onConfirm={(share) => {
          model.revoke(share);
          setStopping(null);
        }}
      />

      <DeleteShareConfirm
        share={deleting}
        busy={model.busyRowKey !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={(share) => {
          model.remove(share);
          setDeleting(null);
        }}
      />

      {password.dialogs}

      {replaying && (
        <Suspense fallback={null}>
          <ReplayViewer share={replaying} onClose={() => setReplaying(null)} />
        </Suspense>
      )}
    </div>
  );
}

function ActiveShareCard({
  model,
  onStop,
  onPasswordAction,
}: {
  model: ShareTabModel;
  onStop: (row: ShareRow) => void;
  onPasswordAction: SharePasswordDialogs['open'];
}) {
  const { t } = useTranslation();
  return (
    <Reveal>
      <Card data-testid="share-active-card">
        <CardHeader>
          <CardTitle>{t('settings.share.active.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {model.failedNodes.length > 0 && (
            <p className="mb-2 text-xs text-muted-foreground" data-testid="share-node-failed">
              {t('settings.share.active.nodeUnavailable', { names: model.failedNodes.join('、') })}
            </p>
          )}
          <ActiveSharesTable
            shares={model.active}
            now={model.now}
            busyRowKey={model.busyRowKey}
            showNode={model.multiNode}
            deviceName={model.deviceName}
            onStop={onStop}
            onPasswordAction={onPasswordAction}
          />
        </CardContent>
      </Card>
    </Reveal>
  );
}

function HistoryShareCard({
  model,
  onReplay,
  onDelete,
}: {
  model: ShareTabModel;
  onReplay: (row: ShareRow) => void;
  onDelete: (row: ShareRow) => void;
}) {
  const { t } = useTranslation();
  return (
    <Reveal delayMs={60}>
      <Card data-testid="share-history-card">
        <CardHeader>
          <CardTitle>{t('settings.share.history.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* 历史是节点本地的记录：多节点时先说清这张表只出当前节点的。 */}
          {model.multiNode && (
            <p className="mb-2 text-xs text-muted-foreground" data-testid="share-history-scope">
              {t('settings.share.history.localOnly')}
            </p>
          )}
          <ShareHistoryTable
            shares={model.history}
            now={model.now}
            busyRowKey={model.busyRowKey}
            deviceName={model.deviceName}
            onReplay={onReplay}
            onDelete={onDelete}
          />
        </CardContent>
      </Card>
    </Reveal>
  );
}

function ShareTabSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4" data-testid="settings-share-tab-skeleton">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
