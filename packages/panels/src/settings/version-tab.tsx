// 「关于」卡的组装：数据来自 ./use-version-tab，展示块来自 ./version-tab-sections。
// 运行模式不在 `/api/system/info` 里（那是 mesh 的本机状态），由宿主查好后传进来。

import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@vibeterm/ui/card';
import { useTranslation } from 'react-i18next';

import { useVersionTab } from './use-version-tab';
import {
  ChangelogSection,
  UpdateCheckButton,
  UpdateCheckResultRow,
  UpgradeConfirmDialog,
  UpgradeProgress,
  VersionInfoRows,
} from './version-tab-sections';

export interface VersionTabProps {
  /** mesh 运行模式的展示文案（独立运行 / 节点 / Hub 兼节点…）；没传即显示「加载中...」。 */
  runMode?: string;
}

export function VersionTab({ runMode }: VersionTabProps = {}) {
  const { t } = useTranslation();
  const model = useVersionTab();
  const { info, update, isUpgrading, upgradeStateText } = model;

  return (
    <Card className="border-0 ring-0">
      <CardHeader>
        <CardTitle>{t('settings.version.title')}</CardTitle>
        <CardAction>
          <UpdateCheckButton
            isChecking={model.isChecking}
            disabled={model.isChecking || isUpgrading}
            onCheck={model.checkUpdate}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-6">
        <VersionInfoRows info={info} deploymentLabel={model.deploymentLabel} runMode={runMode} />

        {update && <UpdateCheckResultRow update={update} />}

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
