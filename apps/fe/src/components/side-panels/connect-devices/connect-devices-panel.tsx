// 「接入更多设备」面板（右侧滑出，`?panel=connect`）：移动设备 / 服务器或电脑两套静态指引。
//
// 两页内容互斥渲染而不是走 TabsContent：内容里带受控子标签与命令块，
// 条件渲染既省掉隐藏分支的开销，也让静态渲染的测试能直接断言当前页。

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ComputerGuide } from './computer-guide';
import { GuideTabs } from './guide-tabs';
import { MobileGuide } from './mobile-guide';

type ConnectTab = 'mobile' | 'computer';

const TABS: ConnectTab[] = ['mobile', 'computer'];

export default function ConnectDevicesPanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ConnectTab>('mobile');

  return (
    <div className="space-y-3" data-testid="connect-devices-panel">
      <GuideTabs
        value={tab}
        onValueChange={setTab}
        fullWidth
        options={TABS.map((value) => ({
          value,
          label: t(`connectDevices.tabs.${value}`),
          testId: `connect-tab-${value}`,
        }))}
      />
      {tab === 'mobile' ? <MobileGuide /> : <ComputerGuide />}
    </div>
  );
}
