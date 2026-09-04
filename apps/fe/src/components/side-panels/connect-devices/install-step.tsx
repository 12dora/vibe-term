// 「安装 tmex」：两条「让新机器加入」的路径共用，SSH 直连不需要它。

import { INSTALL_COMMAND } from '@tmex/shared';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideStep } from './guide-step';

const PATH_COMMAND = 'export PATH="$HOME/.local/bin:$PATH"';

export function InstallStep({ index }: { index: number }) {
  const { t } = useTranslation();
  const prefix = 'connectDevices.computer.install';
  return (
    <GuideStep
      index={index}
      testId="connect-step-install"
      title={t(`${prefix}.title`)}
      description={t(`${prefix}.description`)}
    >
      <CommandBlock value={INSTALL_COMMAND} testId="install" label={t(`${prefix}.command`)} />
      <p className="text-xs text-muted-foreground">{t(`${prefix}.pathHint`)}</p>
      <CommandBlock value={PATH_COMMAND} testId="path" />
    </GuideStep>
  );
}
