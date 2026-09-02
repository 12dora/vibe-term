// 「移动设备（仅控制）」页：先挑一个手机能连上的地址，再扫码打开，最后添加到主屏幕。
// 手输地址是这一步以前唯一的路径，实际上没人愿意在手机上敲 `http://192.168.x.x:9883`；
// 二维码才是主路径，命令块留作扫不了码时的兜底。

import { Tabs, TabsContent } from '@tmex/ui/tabs';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccessAddress } from './access-addresses';
import { CommandBlock } from './command-block';
import { GuideLink, GuideStep } from './guide-step';
import { GuideTabList } from './guide-tabs';
import { useAccessAddresses } from './use-access-addresses';

type Platform = 'ios' | 'android';

const PLATFORMS: Platform[] = ['ios', 'android'];
const HOME_SCREEN_STEPS = ['add', 'launch'] as const;

export interface MobileAddressChoice {
  list: AccessAddress[];
  loopbackHint: boolean;
  selected: AccessAddress | null;
  onSelect: (url: string) => void;
}

/** 选中的地址由平台页上层持有：切 iOS / Android 会把平台页整块卸载，状态放里面会丢。 */
export function useMobileAddressChoice(): MobileAddressChoice {
  const { list, loopbackHint } = useAccessAddresses();
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  // 候选是异步拉出来的：选中的那条还没进列表（或已消失）时退回第一条
  //（`buildAccessAddresses` 已保证第一条是当前真的可达的地址）。
  const selected = list.find((item) => item.url === selectedUrl) ?? list[0] ?? null;
  return { list, loopbackHint, selected, onSelect: setSelectedUrl };
}

function AddressLabel({ address }: { address: AccessAddress }) {
  const { t } = useTranslation();
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-xs font-medium">
        {t(`connectDevices.mobile.address.${address.kind}`)}
      </span>
      <span className="block break-all font-mono text-[11px] text-muted-foreground">
        {address.url}
      </span>
    </span>
  );
}

/** 候选只有一条时不做成单选（点了也没得选），仍然把地址原样摆出来。 */
export function AddressChoiceList({
  list,
  selected,
  onSelect,
}: Omit<MobileAddressChoice, 'loopbackHint'>) {
  const { t } = useTranslation();
  const only = list[0];

  if (list.length <= 1) {
    if (!only) return null;
    return (
      <div className="space-y-1" data-testid="connect-access-addresses">
        <p className="text-[11px] text-muted-foreground">
          {t('connectDevices.mobile.chooseAddress.single')}
        </p>
        <div className="flex items-start gap-2 rounded-lg border border-border/60 p-2">
          <AddressLabel address={only} />
        </div>
      </div>
    );
  }

  // 原生 radio + 视觉上自绘的圆点：分组语义、方向键切换、读屏播报全部白拿，
  // 输入框本身 sr-only，焦点环挂在外层 label 上（has-[:focus-visible]）。
  return (
    <div
      role="radiogroup"
      aria-label={t('connectDevices.mobile.chooseAddress.title')}
      className="space-y-1.5"
      data-testid="connect-access-addresses"
    >
      {list.map((item, index) => {
        const checked = item.url === selected?.url;
        return (
          <label
            key={item.url}
            data-testid={`connect-address-${index}`}
            data-kind={item.kind}
            className={`flex w-full cursor-pointer items-start gap-2 rounded-lg border p-2 transition-colors duration-(--tmex-motion-fast) has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none ${
              checked ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:bg-muted/50'
            }`}
          >
            <input
              type="radio"
              name="connect-access-address"
              value={item.url}
              checked={checked}
              onChange={() => onSelect(item.url)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
                checked ? 'border-primary' : 'border-muted-foreground/40'
              }`}
            >
              {checked ? <span className="size-1.5 rounded-full bg-primary" /> : null}
            </span>
            <AddressLabel address={item} />
          </label>
        );
      })}
    </div>
  );
}

/** 白底衬垫是必须的：深色主题下直接画在 card 上，相机识别率会掉。 */
export function ScanBlock({ platform, url }: { platform: Platform; url: string | null }) {
  const { t } = useTranslation();
  if (!url) return null;

  return (
    <div className="space-y-2">
      <div className="flex justify-center">
        <div className="rounded-lg bg-white p-2" data-testid="connect-qr">
          <QRCodeSVG
            value={url}
            size={176}
            marginSize={2}
            level="M"
            title={t('connectDevices.mobile.scan.alt')}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t(`connectDevices.mobile.${platform}.open.description`)}
      </p>
      <CommandBlock value={url} testId="mobile-address" />
    </div>
  );
}

export function MobilePlatformSteps({
  platform,
  choice,
}: {
  platform: Platform;
  choice: MobileAddressChoice;
}) {
  const { t } = useTranslation();
  const single = choice.list.length <= 1;

  return (
    <div className="space-y-2">
      <GuideStep
        index={1}
        testId={`connect-step-${platform}-address`}
        title={t('connectDevices.mobile.chooseAddress.title')}
        description={single ? undefined : t('connectDevices.mobile.chooseAddress.description')}
      >
        <AddressChoiceList
          list={choice.list}
          selected={choice.selected}
          onSelect={choice.onSelect}
        />
        {choice.loopbackHint ? (
          <p
            className="text-[11px] text-amber-600 dark:text-amber-400"
            data-testid="connect-loopback-hint"
          >
            {t('connectDevices.mobile.address.loopbackHint')}
          </p>
        ) : null}
      </GuideStep>
      <GuideStep
        index={2}
        testId={`connect-step-${platform}-scan`}
        title={t('connectDevices.mobile.scan.title')}
        description={t(`connectDevices.mobile.scan.${platform}`)}
      >
        <ScanBlock platform={platform} url={choice.selected?.url ?? null} />
      </GuideStep>
      {HOME_SCREEN_STEPS.map((step, index) => (
        <GuideStep
          key={step}
          index={index + 3}
          testId={`connect-step-${platform}-${step}`}
          title={t(`connectDevices.mobile.${platform}.${step}.title`)}
          description={t(`connectDevices.mobile.${platform}.${step}.description`)}
        />
      ))}
    </div>
  );
}

export function MobileGuide() {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<Platform>('ios');
  const choice = useMobileAddressChoice();

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
            <MobilePlatformSteps platform={value} choice={choice} />
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
