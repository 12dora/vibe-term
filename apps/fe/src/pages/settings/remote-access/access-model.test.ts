// Access 规则草稿的校验与归一、可应用性判断与步骤标签。

import { describe, expect, test } from 'bun:test';
import type { LocalAuthStatus, TunnelAccessMode, TunnelStatusResponse } from '@tmex/shared';
import {
  type AccessRuleDraft,
  accessConfigureHostname,
  accessEffective,
  accessRulesValid,
  accessStepState,
  accessStepTag,
  accessSyncHostname,
  canApplyAccess,
  canSyncAccess,
  configureAccessRequest,
  effectiveAccessMode,
  isValidRuleValue,
  ruleDraftError,
  ruleDraftsFrom,
  setAccessModeRequest,
  shouldOfferAccessSync,
  toAccessRules,
} from './access-model';

function status(overrides: Partial<TunnelStatusResponse> = {}): TunnelStatusResponse {
  return {
    supported: true,
    platform: 'darwin-arm64',
    binary: { installed: true, version: '2026.1.0', path: '/data/cloudflared', source: 'managed' },
    auth: { loggedIn: true, loginUrl: null },
    config: {
      mode: 'named',
      hostname: 'tmex.example.com',
      tunnelName: 'tmex',
      tunnelId: 'd8e1f0aa',
      autoStart: false,
      externallyManaged: false,
      originPort: 9883,
      accessMode: null,
    },
    process: {
      state: 'running',
      pid: 42,
      startedAt: '2026-08-30T00:00:00.000Z',
      publicUrl: 'https://tmex.example.com',
      lastError: null,
      restarts: 0,
    },
    connector: {
      reachable: null,
      metricsAddr: null,
      readyConnections: null,
      connectorId: null,
      checkedAt: null,
      lastError: null,
    },
    access: {
      hasCredentials: false,
      accountId: null,
      teamDomain: null,
      configured: false,
      appId: null,
      aud: null,
      hostname: null,
      rules: [],
      enforceJwt: true,
      effective: false,
      bypassAppId: null,
      lastError: null,
    },
    external: {
      detected: false,
      source: null,
      configPath: null,
      tunnelId: null,
      tunnelName: null,
      hostnames: [],
      hasOriginCert: false,
      running: false,
    },
    loginEnforced: true,
    exposureProtected: true,
    job: null,
    trustProxy: false,
    configuredTrustProxy: false,
    restartRequired: false,
    log: [],
    ...overrides,
  };
}

function draft(kind: AccessRuleDraft['kind'], value: string): AccessRuleDraft {
  return { key: `k-${value}`, kind, value };
}

describe('isValidRuleValue', () => {
  test('邮箱要完整', () => {
    expect(isValidRuleValue('email', 'you@example.com')).toBe(true);
    expect(isValidRuleValue('email', 'a.b+tag@sub.example.co.uk')).toBe(true);
    expect(isValidRuleValue('email', 'example.com')).toBe(false);
    expect(isValidRuleValue('email', 'you@example')).toBe(false);
    expect(isValidRuleValue('email', 'you @example.com')).toBe(false);
    expect(isValidRuleValue('email', '')).toBe(false);
  });

  test('邮箱域至少两级且不能带 @', () => {
    expect(isValidRuleValue('email_domain', 'example.com')).toBe(true);
    expect(isValidRuleValue('email_domain', 'mail.example.co.uk')).toBe(true);
    expect(isValidRuleValue('email_domain', 'example')).toBe(false);
    expect(isValidRuleValue('email_domain', 'you@example.com')).toBe(false);
    expect(isValidRuleValue('email_domain', ' ')).toBe(false);
  });

  test('两侧空白不算错', () => {
    expect(isValidRuleValue('email', '  you@example.com  ')).toBe(true);
  });
});

describe('ruleDraftError / accessRulesValid', () => {
  test('空值与非法值分开报', () => {
    expect(ruleDraftError(draft('email', ''))).toBe('empty');
    expect(ruleDraftError(draft('email', 'nope'))).toBe('invalid');
    expect(ruleDraftError(draft('email', 'you@example.com'))).toBeNull();
  });

  test('至少一条且每条都合法才算可提交', () => {
    expect(accessRulesValid([])).toBe(false);
    expect(accessRulesValid([draft('email', '')])).toBe(false);
    expect(accessRulesValid([draft('email', 'you@example.com'), draft('email_domain', 'x')])).toBe(
      false
    );
    expect(
      accessRulesValid([draft('email', 'you@example.com'), draft('email_domain', 'example.com')])
    ).toBe(true);
  });
});

describe('toAccessRules / ruleDraftsFrom', () => {
  test('提交前去空白并转小写', () => {
    expect(toAccessRules([draft('email', '  You@Example.COM ')])).toEqual([
      { kind: 'email', value: 'you@example.com' },
    ]);
  });

  test('服务端规则转草稿时键稳定且不改值', () => {
    expect(ruleDraftsFrom([{ kind: 'email_domain', value: 'example.com' }])).toEqual([
      { key: 'saved-0', kind: 'email_domain', value: 'example.com' },
    ]);
  });
});

describe('目标主机名与可应用性', () => {
  test('配置目标：已建隧道用 config.hostname，没建时用向导确认的草稿', () => {
    expect(accessConfigureHostname(status(), '')).toBe('tmex.example.com');
    // 已有应用覆盖的主机名不参与推导：后端配置动作不认它。
    expect(
      accessConfigureHostname(
        status({ access: { ...status().access, hostname: 'old.example.com' } }),
        ''
      )
    ).toBe('tmex.example.com');
    const noTunnel = status({ config: { ...status().config, mode: 'off', hostname: null } });
    expect(accessConfigureHostname(noTunnel, '  draft.example.com  ')).toBe('draft.example.com');
    expect(accessConfigureHostname(noTunnel, '   ')).toBeNull();
  });

  test('同步目标：config.hostname，其次探测到的系统隧道主机名', () => {
    expect(accessSyncHostname(status())).toBe('tmex.example.com');
    const noTunnel = status({ config: { ...status().config, mode: 'off', hostname: null } });
    expect(accessSyncHostname(noTunnel)).toBeNull();
    expect(
      accessSyncHostname({
        ...noTunnel,
        external: { ...noTunnel.external, detected: true, hostnames: ['ext.example.com'] },
      })
    ).toBe('ext.example.com');
    // 草稿不是同步目标：后端同步动作只认 config 与 external。
    expect(accessSyncHostname(noTunnel)).toBeNull();
  });

  test('凭证、目标主机名、规则三者齐全才能应用', () => {
    const rules = [draft('email', 'you@example.com')];
    expect(canApplyAccess(status(), rules, '')).toBe(false);
    const withCreds = status({ access: { ...status().access, hasCredentials: true } });
    expect(canApplyAccess(withCreds, rules, '')).toBe(true);
    expect(canApplyAccess(withCreds, [], '')).toBe(false);
    const noTunnel = status({
      access: { ...status().access, hasCredentials: true },
      config: { ...status().config, mode: 'off', hostname: null },
    });
    expect(canApplyAccess(noTunnel, rules, '')).toBe(false);
    // 隧道还没建，但向导里已经确认了主机名：可以先把 Access 配好。
    expect(canApplyAccess(noTunnel, rules, 'draft.example.com')).toBe(true);
  });

  test('同步只看 config 与 external，草稿不算', () => {
    const noHostname = status({
      access: { ...status().access, hasCredentials: true },
      config: { ...status().config, mode: 'off', hostname: null },
    });
    expect(canSyncAccess(noHostname)).toBe(false);
    expect(
      canSyncAccess({
        ...noHostname,
        external: { ...noHostname.external, detected: true, hostnames: ['tmex.example.com'] },
      })
    ).toBe(true);
    // 没保存凭证时依然不能同步。
    expect(canSyncAccess(status())).toBe(false);
  });

  test('凭证在、主机名在、应用还没有时提示先同步', () => {
    expect(shouldOfferAccessSync(status())).toBe(false);
    const withCreds = status({ access: { ...status().access, hasCredentials: true } });
    expect(shouldOfferAccessSync(withCreds)).toBe(true);
    expect(
      shouldOfferAccessSync(
        status({ access: { ...status().access, hasCredentials: true, configured: true } })
      )
    ).toBe(false);
  });
});

describe('configureAccessRequest', () => {
  const rules = [{ kind: 'email' as const, value: 'you@example.com' }];

  test('已建隧道时不带主机名，交给服务端用 config.hostname', () => {
    expect(configureAccessRequest(status(), rules, 'draft.example.com')).toEqual({
      action: 'configure_access',
      rules,
    });
  });

  test('隧道还没建时带上向导确认的主机名', () => {
    const noTunnel = status({ config: { ...status().config, mode: 'off', hostname: null } });
    expect(configureAccessRequest(noTunnel, rules, ' draft.example.com ')).toEqual({
      action: 'configure_access',
      rules,
      hostname: 'draft.example.com',
    });
    expect(configureAccessRequest(noTunnel, rules, '')).toEqual({
      action: 'configure_access',
      rules,
    });
  });
});

describe('setAccessModeRequest', () => {
  test('只组请求体，暴露确认由 withExposureAck 补', () => {
    expect(setAccessModeRequest('none')).toEqual({ action: 'set_access_mode', accessMode: 'none' });
    expect(setAccessModeRequest('login')).toEqual({
      action: 'set_access_mode',
      accessMode: 'login',
    });
    expect(setAccessModeRequest('cloudflare')).toEqual({
      action: 'set_access_mode',
      accessMode: 'cloudflare',
    });
  });
});

describe('accessStepTag', () => {
  test('还没有任何保护时标推荐，已选过或已有保护时标可选', () => {
    expect(accessStepTag(status({ loginEnforced: false }))).toBe('recommended');
    expect(accessStepTag(status({ loginEnforced: true }))).toBe('optional');
    expect(accessStepTag(withMode(status({ loginEnforced: false }), 'none'))).toBe('optional');
  });

  test('旧数据里留着一个没生效的 Access 应用：还是没有保护，仍标推荐', () => {
    const ineffective = status({
      loginEnforced: false,
      access: {
        ...status().access,
        configured: true,
        enforceJwt: true,
        hostname: 'old.example.com',
        effective: false,
      },
    });
    expect(accessStepTag(ineffective)).toBe('recommended');
    expect(
      accessStepTag({
        ...ineffective,
        access: { ...ineffective.access, hostname: 'tmex.example.com', effective: true },
      })
    ).toBe('optional');
  });
});

function withMode(s: TunnelStatusResponse, accessMode: TunnelAccessMode): TunnelStatusResponse {
  return { ...s, config: { ...s.config, accessMode } };
}

function localAuth(overrides: Partial<LocalAuthStatus> = {}): LocalAuthStatus {
  return {
    supported: true,
    enabled: false,
    effective: false,
    credentialsPresent: false,
    ...overrides,
  };
}

describe('effectiveAccessMode', () => {
  test('用户选过就以选择为准', () => {
    for (const mode of ['none', 'login', 'cloudflare'] as const) {
      expect(effectiveAccessMode(withMode(status(), mode))).toBe(mode);
    }
  });

  test('没选过时按实际保护推导：Access 校验 > 登录门 > 没生效的 Access 应用 > 未选择', () => {
    const effective = status({
      loginEnforced: false,
      access: {
        ...status().access,
        configured: true,
        enforceJwt: true,
        hostname: 'tmex.example.com',
        effective: true,
      },
    });
    expect(effectiveAccessMode(effective)).toBe('cloudflare');
    expect(effectiveAccessMode(status({ loginEnforced: true }))).toBe('login');
    expect(effectiveAccessMode(status({ loginEnforced: false }))).toBeNull();
  });

  test('应用建了但没生效：有登录门时算登录，没有登录门时仍归到 Access 这一档', () => {
    const ineffective = {
      ...status().access,
      configured: true,
      enforceJwt: true,
      hostname: 'old.example.com',
      effective: false,
    };
    expect(effectiveAccessMode(status({ loginEnforced: true, access: ineffective }))).toBe('login');
    // 没有登录门：这一档展开后正好告诉用户应用哪里没配对。
    expect(effectiveAccessMode(status({ loginEnforced: false, access: ineffective }))).toBe(
      'cloudflare'
    );
  });
});

describe('accessStepState', () => {
  test('没选过时停在当前步', () => {
    expect(accessStepState(status({ loginEnforced: false }))).toBe('current');
  });

  test('选「无」就是做完了', () => {
    expect(accessStepState(withMode(status({ loginEnforced: false }), 'none'))).toBe('done');
  });

  test('选「账号密码」要真有登录门才算做完', () => {
    const noLogin = withMode(status({ loginEnforced: false }), 'login');
    expect(accessStepState(noLogin)).toBe('current');
    // mesh 的登录门与本机登录都算数；`localAuth` 缺失时不当作已保护。
    expect(accessStepState(withMode(status({ loginEnforced: true }), 'login'))).toBe('done');
    expect(accessStepState(noLogin, localAuth())).toBe('current');
    expect(accessStepState(noLogin, localAuth({ supported: false }))).toBe('done');
    expect(
      accessStepState(
        noLogin,
        localAuth({ enabled: true, effective: true, credentialsPresent: true })
      )
    ).toBe('done');
  });

  test('选 Cloudflare Access 要校验真的生效才算做完', () => {
    const chosen = withMode(status({ loginEnforced: false }), 'cloudflare');
    expect(accessStepState(chosen)).toBe('current');
    const effective = withMode(
      status({
        loginEnforced: false,
        access: {
          ...status().access,
          configured: true,
          enforceJwt: true,
          hostname: 'tmex.example.com',
          effective: true,
        },
      }),
      'cloudflare'
    );
    expect(accessStepState(effective)).toBe('done');
  });
});

describe('accessEffective', () => {
  test('以后端的 effective 为准，缺字段时按同一条谓词兜底', () => {
    const base = status({
      access: {
        ...status().access,
        configured: true,
        enforceJwt: true,
        hostname: 'tmex.example.com',
        effective: true,
      },
    });
    expect(accessEffective(base)).toBe(true);
    expect(accessEffective({ ...base, access: { ...base.access, effective: false } })).toBe(false);
    const { effective: _effective, ...legacy } = base.access;
    expect(accessEffective({ ...base, access: legacy as TunnelStatusResponse['access'] })).toBe(
      true
    );
  });
});
