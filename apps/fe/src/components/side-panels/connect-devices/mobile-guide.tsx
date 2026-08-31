// 「移动设备（仅控制）」页：iOS / Android 两套三步指引，第一步给出手机可用的访问地址。

import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink, GuideStep } from './guide-step';
import { GuideTabList } from './guide-tabs';
import { useAccessAddresses } from './use-access-addresses';

type Platform = 'ios' | 'android';

const PLATFORMS: Platform[] = ['ios', 'android'];
const MOBILE_STEPS = ['open', 'add', 'launch'] as const;

function AccessAddressList() {
  const { t } = useTranslation();
  const { list, loopbackHint } = useAccessAddresses();
  return (
    <div className="space-y-2" data-testid="connect-access-addresses">
      {list.map((item, index) => (
        <CommandBlock
          key={item.url}
          value={item.url}
          testId={`address-${index}`}
          label={t(`connectDevices.mobile.address.${item.kind}`)}
        />
      ))}
      {loopbackHint && (
        <p
          className="text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="connect-loopback-hint"
        >
          {t('connectDevices.mobile.address.loopbackHint')}
        </p>
      )}
    </div>
  );
}

export function MobilePlatformSteps({ platform }: { platform: Platform }) {
  const { t } = useTranslation();
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
          {step === 'open' ? <AccessAddressList /> : null}
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
