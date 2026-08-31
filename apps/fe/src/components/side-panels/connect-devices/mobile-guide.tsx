// 「移动设备（仅控制）」页：iOS / Android 两套三步指引，第一步给出本机当前地址。

import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink, GuideStep } from './guide-step';
import { GuideTabList } from './guide-tabs';

type Platform = 'ios' | 'android';

const PLATFORMS: Platform[] = ['ios', 'android'];
const MOBILE_STEPS = ['open', 'add', 'launch'] as const;

/** 手机要访问的就是当前这份前端的来源地址；SSR / 测试静态渲染时兜底为空串。 */
function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function MobilePlatformSteps({ platform }: { platform: Platform }) {
  const { t } = useTranslation();
  const origin = currentOrigin();
  return (
    <div className="space-y-2">
      {MOBILE_STEPS.map((step, index) => (
        <GuideStep
          key={step}
          index={index + 1}
          testId={`connect-step-${platform}-${step}`}
          title={t(`connectDevices.mobile.${platform}.${step}.title`)}
          description={t(`connectDevices.mobile.${platform}.${step}.description`)}
        >
          {step === 'open' ? (
            <CommandBlock
              value={origin}
              testId="origin"
              label={t('connectDevices.mobile.addressLabel')}
            />
          ) : null}
        </GuideStep>
      ))}
    </div>
  );
}

export function MobileGuide() {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform>('ios');

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('connectDevices.mobile.intro')}</p>
      <Tabs value={platform} onValueChange={(next) => setPlatform(next as Platform)}>
        <GuideTabList
          options={PLATFORMS.map((value) => ({
            value,
            label: t(`connectDevices.mobile.platform.${value}`),
            testId: `connect-platform-${value}`,
          }))}
        />
        {PLATFORMS.map((value) => (
          <TabsContent key={value} value={value}>
            <MobilePlatformSteps platform={value} />
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-xs text-muted-foreground">
        {t('connectDevices.mobile.remoteHint')}{' '}
        <GuideLink to="/settings?tab=remoteAccess" testId="connect-mobile-remote-link">
          {t('connectDevices.mobile.remoteLink')}
        </GuideLink>
      </p>
    </div>
  );
}
