// 设置页「分享」标签：进行中的分享、历史与日志回放、分享设置。
// 数据与写操作在 use-share-tab.ts；回放窗按需加载（终端渲染器不该跟着这个标签一起下载）。

import { lazyChunk } from '@/lazy-chunk';
import type { ShareRecord } from '@tmex/shared/share';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Reveal } from '@tmex/ui/motion';
import { Skeleton } from '@tmex/ui/skeleton';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { ActiveSharesTable } from './active-shares-table';
import { ShareHistoryTable } from './history-table';
import { DeleteShareConfirm, StopShareConfirm } from './share-confirms';
import { ShareSettingsCard } from './share-settings-card';
import { useShareTab } from './use-share-tab';

const ReplayViewer = lazyChunk(() => import('./replay-viewer').then((m) => m.ReplayViewer));

export function ShareTab() {
  const { t } = useTranslation();
  const model = useShareTab();
  const [stopping, setStopping] = useState<ShareRecord | null>(null);
  const [deleting, setDeleting] = useState<ShareRecord | null>(null);
  const [replaying, setReplaying] = useState<ShareRecord | null>(null);

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

      <Reveal>
        <Card data-testid="share-active-card">
          <CardHeader>
            <CardTitle>{t('settings.share.active.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ActiveSharesTable
              shares={model.active}
              now={model.now}
              busyShareId={model.busyShareId}
              deviceName={model.deviceName}
              onStop={setStopping}
            />
          </CardContent>
        </Card>
      </Reveal>

      <Reveal delayMs={60}>
        <Card data-testid="share-history-card">
          <CardHeader>
            <CardTitle>{t('settings.share.history.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ShareHistoryTable
              shares={model.history}
              now={model.now}
              busyShareId={model.busyShareId}
              deviceName={model.deviceName}
              onReplay={setReplaying}
              onDelete={setDeleting}
            />
          </CardContent>
        </Card>
      </Reveal>

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
        busy={model.busyShareId !== null}
        onCancel={() => setStopping(null)}
        onConfirm={(share) => {
          model.revoke(share);
          setStopping(null);
        }}
      />

      <DeleteShareConfirm
        share={deleting}
        busy={model.busyShareId !== null}
        onCancel={() => setDeleting(null)}
        onConfirm={(share) => {
          model.remove(share);
          setDeleting(null);
        }}
      />

      {replaying && (
        <Suspense fallback={null}>
          <ReplayViewer share={replaying} onClose={() => setReplaying(null)} />
        </Suspense>
      )}
    </div>
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
