import { describe, expect, test } from 'bun:test';
import type { SiteSettings } from '@tmex/shared';
import type { LocaleCode } from '@tmex/shared';
import {
  type SiteSettingsLinkage,
  type SiteSettingsWithLinkage,
  UNLINKED_SITE_SETTINGS,
  buildSiteSettingsPatch,
  createDefaultSiteSettingsDraft,
  createLanguagePreviewController,
  hasSiteSettingsChanges,
  planSiteSettingsSave,
  resolveLanguageSwitch,
  siteSettingsLinkage,
  siteSettingsToDraft,
} from './site-settings-form';

function makeSettings(overrides: Partial<SiteSettings> = {}): SiteSettings {
  return {
    siteName: 'my-tmex',
    siteUrl: 'https://tmex.example.com',
    bellThrottleSeconds: 12,
    notificationThrottleSeconds: 7,
    enableBrowserNotificationToast: false,
    enableNotificationPush: false,
    enableBellPush: false,
    enableBellSound: false,
    sshReconnectMaxRetries: 8,
    sshReconnectDelaySeconds: 45,
    language: 'zh_CN',
    theme: 'dark',
    disabledNotificationChannels: ['webhook'],
    updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('createDefaultSiteSettingsDraft', () => {
  test('未加载站点设置前使用与旧实现一致的默认值', () => {
    const draft = createDefaultSiteSettingsDraft('https://local.example');

    expect(draft).toEqual({
      siteName: 'tmex',
      siteUrl: 'https://local.example',
      language: 'en_US',
      bellThrottleSeconds: 6,
      notificationThrottleSeconds: 3,
      enableBrowserNotificationToast: true,
      enableNotificationPush: true,
      enableBellPush: true,
      enableBellSound: true,
      sshReconnectMaxRetries: 2,
      sshReconnectDelaySeconds: 10,
    });
  });
});

describe('siteSettingsToDraft', () => {
  test('加载后的设置全量注水，含 SSH 重连配置', () => {
    const draft = siteSettingsToDraft(makeSettings());

    expect(draft).toEqual({
      siteName: 'my-tmex',
      siteUrl: 'https://tmex.example.com',
      language: 'zh_CN',
      bellThrottleSeconds: 12,
      notificationThrottleSeconds: 7,
      enableBrowserNotificationToast: false,
      enableNotificationPush: false,
      enableBellPush: false,
      enableBellSound: false,
      sshReconnectMaxRetries: 8,
      sshReconnectDelaySeconds: 45,
    });
  });

  test('缺失字段回落到默认值', () => {
    const partial = makeSettings();
    // 老服务端可能不返回这些字段
    (partial as Partial<SiteSettings>).language = undefined;
    (partial as Partial<SiteSettings>).notificationThrottleSeconds = undefined;
    (partial as Partial<SiteSettings>).enableBellSound = undefined;
    (partial as Partial<SiteSettings>).sshReconnectMaxRetries = undefined;
    (partial as Partial<SiteSettings>).sshReconnectDelaySeconds = undefined;

    const draft = siteSettingsToDraft(partial);

    expect(draft.language).toBe('en_US');
    expect(draft.notificationThrottleSeconds).toBe(3);
    expect(draft.enableBellSound).toBe(true);
    expect(draft.sshReconnectMaxRetries).toBe(2);
    expect(draft.sshReconnectDelaySeconds).toBe(10);
  });
});

describe('buildSiteSettingsPatch', () => {
  test('只带改动过的字段：未动的 SSH 重连配置不进 PATCH', () => {
    const baseline = siteSettingsToDraft(makeSettings());
    const patch = buildSiteSettingsPatch(baseline, { ...baseline, siteName: 'renamed' });

    expect(patch).toEqual({ siteName: 'renamed' });
  });

  test('一个字段都没动：空 PATCH', () => {
    const baseline = siteSettingsToDraft(makeSettings());

    expect(buildSiteSettingsPatch(baseline, { ...baseline })).toEqual({});
  });

  test('skip 里的字段即使改了也不带上（托管字段）', () => {
    const baseline = siteSettingsToDraft(makeSettings());
    const draft = { ...baseline, siteUrl: 'https://other.example', bellThrottleSeconds: 30 };
    const patch = buildSiteSettingsPatch(baseline, draft, new Set(['siteUrl']));

    expect(patch).toEqual({ bellThrottleSeconds: 30 });
  });
});

describe('siteSettingsLinkage', () => {
  test('mesh 下的四个字段原样读出', () => {
    const settings: SiteSettingsWithLinkage = {
      ...makeSettings(),
      effectiveSiteUrl: 'https://hub.example',
      siteUrlEditable: false,
      siteNameLinkedToNode: true,
      nodeId: 'abc',
    };

    expect(siteSettingsLinkage(settings)).toEqual({
      siteNameLinkedToNode: true,
      siteUrlEditable: false,
      effectiveSiteUrl: 'https://hub.example',
      nodeId: 'abc',
    });
  });

  test('老服务端不下发这些字段：退回可自由编辑、不联动', () => {
    expect(siteSettingsLinkage(makeSettings())).toEqual(UNLINKED_SITE_SETTINGS);
  });
});

describe('planSiteSettingsSave', () => {
  const baseline = siteSettingsToDraft(makeSettings());
  const meshLinkage: SiteSettingsLinkage = {
    siteNameLinkedToNode: true,
    siteUrlEditable: false,
    effectiveSiteUrl: 'https://hub.example',
    nodeId: 'node-1',
  };

  test('未联动：改名走 PATCH，没有 rename', () => {
    const plan = planSiteSettingsSave(
      baseline,
      { ...baseline, siteName: 'renamed' },
      UNLINKED_SITE_SETTINGS
    );

    expect(plan).toEqual({ renameNodeTo: null, patch: { siteName: 'renamed' } });
    expect(hasSiteSettingsChanges(plan)).toBe(true);
  });

  test('联动时只改了名字：走 rename，一条 PATCH 都不发', () => {
    const plan = planSiteSettingsSave(baseline, { ...baseline, siteName: ' studio ' }, meshLinkage);

    expect(plan).toEqual({ renameNodeTo: 'studio', patch: null });
  });

  test('联动时名字没变：既不 rename 也不 PATCH', () => {
    const plan = planSiteSettingsSave(baseline, { ...baseline }, meshLinkage);

    expect(plan).toEqual({ renameNodeTo: null, patch: null });
    expect(hasSiteSettingsChanges(plan)).toBe(false);
  });

  test('联动时名字被清空：不发一条把节点改成空名的 rename', () => {
    const plan = planSiteSettingsSave(baseline, { ...baseline, siteName: '   ' }, meshLinkage);

    expect(plan.renameNodeTo).toBeNull();
  });

  test('地址不可编辑：即使草稿被改也不进 PATCH，其余字段照常', () => {
    const plan = planSiteSettingsSave(
      baseline,
      { ...baseline, siteUrl: 'https://tampered.example', language: 'en_US' },
      meshLinkage
    );

    expect(plan.patch).toEqual({ language: 'en_US' });
  });

  test('改名与其它字段同时改：两条动作各自成立', () => {
    const plan = planSiteSettingsSave(
      baseline,
      { ...baseline, siteName: 'studio', bellThrottleSeconds: 20 },
      meshLinkage
    );

    expect(plan).toEqual({ renameNodeTo: 'studio', patch: { bellThrottleSeconds: 20 } });
  });
});

// 语言实时预览 / 离开设置页回退，都靠这个判定决定要不要动整页共享的 i18next 单例。
describe('resolveLanguageSwitch', () => {
  test('自身 runtime 选了别的语言：返回该语言，供 changeLanguage 立即生效', () => {
    expect(
      resolveLanguageSwitch({
        controlsBrowserPrefs: true,
        currentLanguage: 'en_US',
        targetLanguage: 'zh_CN',
      })
    ).toBe('zh_CN');
  });

  test('目标语言就是当前语言：不重复切换', () => {
    expect(
      resolveLanguageSwitch({
        controlsBrowserPrefs: true,
        currentLanguage: 'zh_CN',
        targetLanguage: 'zh_CN',
      })
    ).toBeNull();
  });

  test('远端 node 的设置页（controlsBrowserPrefs=false）不改整页语言', () => {
    expect(
      resolveLanguageSwitch({
        controlsBrowserPrefs: false,
        currentLanguage: 'en_US',
        targetLanguage: 'zh_CN',
      })
    ).toBeNull();
  });

  test('目标语言缺失（设置尚未加载 / 本次改的不是语言字段）：不动语言', () => {
    for (const targetLanguage of [undefined, null]) {
      expect(
        resolveLanguageSwitch({
          controlsBrowserPrefs: true,
          currentLanguage: 'en_US',
          targetLanguage,
        })
      ).toBeNull();
    }
  });

  test('回退场景：预览过 zh_CN 未保存就离开，退回已保存的 ja_JP', () => {
    expect(
      resolveLanguageSwitch({
        controlsBrowserPrefs: true,
        currentLanguage: 'zh_CN',
        targetLanguage: 'ja_JP',
      })
    ).toBe('ja_JP');
  });
});

// 控制器替 i18next 单例做决策，这里用一个记录调用的假 i18n 驱动完整时序：
// 加载设置 → 下拉选语言（实时预览）→ 保存 / 直接离开。
function makeController(controlsBrowserPrefs = true) {
  let currentLanguage = 'en_US';
  const changed: LocaleCode[] = [];
  const controller = createLanguagePreviewController({
    controlsBrowserPrefs: () => controlsBrowserPrefs,
    currentLanguage: () => currentLanguage,
    changeLanguage: (language) => {
      changed.push(language);
      currentLanguage = language;
    },
  });
  return { controller, changed, language: () => currentLanguage };
}

describe('createLanguagePreviewController', () => {
  test('选中语言立即生效，不必保存也不必刷新', () => {
    const { controller, changed, language } = makeController();
    controller.hydrate('en_US');
    controller.preview('zh_CN');

    expect(changed).toEqual(['zh_CN']);
    expect(language()).toBe('zh_CN');
  });

  test('改的不是语言字段时不动界面语言', () => {
    const { controller, changed } = makeController();
    controller.hydrate('en_US');
    controller.preview(undefined);

    expect(changed).toEqual([]);
  });

  test('预览后未保存就离开设置页：退回已保存的语言', () => {
    const { controller, changed, language } = makeController();
    controller.hydrate('en_US');
    controller.preview('zh_CN');
    controller.release();

    expect(changed).toEqual(['zh_CN', 'en_US']);
    expect(language()).toBe('en_US');
  });

  test('保存成功后离开设置页：新语言保留，不回退', () => {
    const { controller, changed, language } = makeController();
    controller.hydrate('en_US');
    controller.preview('zh_CN');
    controller.commit('zh_CN');
    controller.release();

    expect(changed).toEqual(['zh_CN']);
    expect(language()).toBe('zh_CN');
  });

  test('设置尚未加载就离开（草稿仍是默认值）：不动界面语言', () => {
    const { controller, changed } = makeController();
    controller.release();

    expect(changed).toEqual([]);
  });

  test('重拉设置把草稿盖回已保存值时，界面语言同步回退，不与草稿脱节', () => {
    const { controller, changed, language } = makeController();
    controller.hydrate('en_US');
    controller.preview('ja_JP');
    controller.hydrate('en_US');

    expect(changed).toEqual(['ja_JP', 'en_US']);
    expect(language()).toBe('en_US');
  });

  test('远端 node 的设置页（controlsBrowserPrefs=false）全程不改整页语言', () => {
    const { controller, changed } = makeController(false);
    controller.hydrate('zh_CN');
    controller.preview('ja_JP');
    controller.release();

    expect(changed).toEqual([]);
  });
});

describe('createLanguagePreviewController：语言包在途', () => {
  test('预览的语言包还没加载完（i18n.language 未变）就离开：仍要发出回退', () => {
    const changed: string[] = [];
    // changeLanguage 异步：currentLanguage 始终停在旧值，模拟 chunk 尚未落地
    const controller = createLanguagePreviewController({
      controlsBrowserPrefs: () => true,
      currentLanguage: () => 'en_US',
      changeLanguage: (language) => {
        changed.push(language);
      },
    });
    controller.hydrate('en_US');
    controller.preview('zh_CN');
    controller.release();

    expect(changed).toEqual(['zh_CN', 'en_US']);
  });
});
