// 「SSH 直连」路径：新机器不装 tmex，由本机以 SSH 设备的形式接上。
// 按钮跳设备页并打开新建设备对话框（类型在对话框里选 SSH）。

import { hostAppPath } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { GuideNote, GuideStep } from './guide-step';
import { openSelfAddDevice } from './open-add-device';

const PREFIX = 'connectDevices.computer.ssh';

/** 一级选择占第 1 步，SSH 不需要安装 tmex，直接接第 2 步。 */
export const SSH_STEP_OFFSET = 2;

export function SshSteps({ startIndex = SSH_STEP_OFFSET }: { startIndex?: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { host } = useRuntime();
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  const openDialog = () => {
    cancelRef.current?.();
    navigate(hostAppPath(host, '/devices'));
    cancelRef.current = openSelfAddDevice();
  };

  return (
    <>
      <p className="text-xs text-muted-foreground" data-testid="connect-ssh-intro">
        {t(`${PREFIX}.description`)}
      </p>
      <GuideStep
        index={startIndex}
        testId="connect-step-ssh-add"
        title={t(`${PREFIX}.title`)}
        description={t(`${PREFIX}.stepDescription`)}
      >
        <div>
          <Button size="xs" variant="outline" data-testid="connect-ssh-add" onClick={openDialog}>
            {t(`${PREFIX}.button`)}
          </Button>
        </div>
        <GuideNote testId="connect-ssh-note">{t(`${PREFIX}.note`)}</GuideNote>
      </GuideStep>
    </>
  );
}
