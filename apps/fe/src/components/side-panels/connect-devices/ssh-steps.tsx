// 「SSH 直连」路径：新机器不装 tmex，由本机以 SSH 设备的形式接上。
// 按钮跳设备页并打开新建设备对话框，类型已预选为 SSH。

import type { AddDevicePreset } from '@tmex/panels/device-management';
import { hostAppPath } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { GuideNote, GuideStep } from './guide-step';
import { type OpenAddDeviceOptions, openSelfAddDevice } from './open-add-device';

const PREFIX = 'connectDevices.computer.ssh';

/** 一级选择占第 1 步，SSH 不需要安装 tmex，直接接第 2 步。 */
export const SSH_STEP_OFFSET = 2;

/** 这条路径只做 SSH 设备：对话框直接开在 SSH 上，不让用户再选一次类型。 */
export const SSH_ADD_DEVICE_PRESET: AddDevicePreset = { type: 'ssh' };

/**
 * 先登记等待器再导航。导航摘掉 `?panel=connect`，本组件随即卸载；等待器要是挂在组件
 * 生命周期上，声明的 15 秒实际只活到侧栏退场那一刻，设备页稍慢一点就只导航不开对话框。
 */
export function startAddDeviceFlow(navigate: () => void, options: OpenAddDeviceOptions = {}): void {
  openSelfAddDevice(options);
  navigate();
}

export function SshSteps({ startIndex = SSH_STEP_OFFSET }: { startIndex?: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { host } = useRuntime();

  const openDialog = () => {
    startAddDeviceFlow(() => void navigate(hostAppPath(host, '/devices')), {
      preset: SSH_ADD_DEVICE_PRESET,
    });
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
