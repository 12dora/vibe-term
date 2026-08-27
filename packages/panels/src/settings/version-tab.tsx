// 版本设置页组装：数据来自 ./use-version-tab，展示块来自 ./version-tab-sections。

import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { useTranslation } from 'react-i18next';

import { useVersionTab } from './use-version-tab';
import {
  ChangelogSection,
  UpdateCheckRow,
  UpgradeConfirmDialog,
  UpgradeProgress,
  VersionInfoRows,
} from './version-tab-sections';

export function VersionTab() {
  const { t } = useTranslation();
  const model = useVersionTab();
  const { info, update, isUpgrading, upgradeStateText } = model;

  return (
    <Card className="border-0 ring-0">
      <CardHeader>
        <CardTitle>{t('settings.version.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <VersionInfoRows info={info} deploymentLabel={model.deploymentLabel} />

        <UpdateCheckRow
          update={update}
          isChecking={model.isChecking}
          disabled={model.isChecking || isUpgrading}
          onCheck={model.checkUpdate}
        />

        {model.isCheckFailed && (
          <div className="text-sm text-destructive">{t('settings.version.checkFailed')}</div>
        )}

        {update?.hasUpdate && (
          <ChangelogSection
            changelog={update.changelog}
            canSelfUpdate={Boolean(info?.canSelfUpdate)}
            disabledReason={model.disabledReason}
            upgradeDisabled={isUpgrading || model.isUpgradeStarting}
            onUpgrade={() => model.setShowConfirm(true)}
            isUpgrading={isUpgrading}
          />
        )}

        {isUpgrading && upgradeStateText && <UpgradeProgress stateText={upgradeStateText} />}
      </CardContent>

      <UpgradeConfirmDialog
        open={model.showConfirm}
        onOpenChange={model.setShowConfirm}
        onCancel={() => model.setShowConfirm(false)}
        onConfirm={model.confirmUpgrade}
      />
    </Card>
  );
}
