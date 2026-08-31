// 「接入更多设备」面板（右侧滑出，`?panel=connect`）：移动设备 / 服务器或电脑两套静态指引。
//
// 两页各挂一个 TabsContent：Base UI 默认只挂载当前面板，未选中那页不进 DOM，
// 同时按钮与面板之间的 tab / tabpanel 关联由 Tabs 根统一分配。

import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ComputerGuide } from './computer-guide';
import { GuideTabList } from './guide-tabs';
import { MobileGuide } from './mobile-guide';

type ConnectTab = 'mobile' | 'computer';

const TABS: ConnectTab[] = ['mobile', 'computer'];

export default function ConnectDevicesPanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ConnectTab>('mobile');

  return (
    <Tabs
      className="gap-3"
      value={tab}
      onValueChange={(next) => setTab(next as ConnectTab)}
      data-testid="connect-devices-panel"
    >
      <GuideTabList
        fullWidth
        options={TABS.map((value) => ({
          value,
          label: t(`connectDevices.tabs.${value}`),
          testId: `connect-tab-${value}`,
        }))}
      />
      <TabsContent value="mobile">
        <MobileGuide />
      </TabsContent>
      <TabsContent value="computer">
        <ComputerGuide />
      </TabsContent>
    </Tabs>
  );
}
