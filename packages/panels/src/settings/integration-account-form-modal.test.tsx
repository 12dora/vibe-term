// 通用集成表单弹窗：字段 schema 渲染 / 校验拦截提交 / 提交载荷形状 / 编辑态回填 / 密钥字段掩码。
// 弹窗外壳走 portal，静态渲染取不到，因此渲染断言直接打在 IntegrationFormFields 上。

import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@tmex/shared';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import {
  type IntegrationField,
  IntegrationFormFields,
  type IntegrationFormValues,
  integrationCanSubmit,
  integrationInitialValues,
  nonEmptyText,
} from './integration-account-form-modal';
import { telegramBotFormConfig } from './telegram-bot-form-modal';
import { weixinAccountFormConfig } from './weixin-account-form-modal';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

interface DemoEntity {
  id: string;
  name: string;
  secret: string;
  enabled: boolean;
}

const demoFields: IntegrationField<DemoEntity>[] = [
  {
    kind: 'text',
    key: 'name',
    inputId: 'demo-name',
    testId: 'demo-name-input',
    labelKey: 'weixin.accountName',
    placeholderKey: 'weixin.accountNamePlaceholder',
    initialValue: (entity) => entity?.name ?? '',
    validate: nonEmptyText,
  },
  {
    kind: 'secret',
    key: 'secret',
    inputId: 'demo-secret',
    testId: 'demo-secret-input',
    labelKey: 'telegram.botToken',
    placeholderKey: ({ isEdit }) =>
      isEdit ? 'telegram.tokenPlaceholder' : 'telegram.botTokenPlaceholder',
    initialValue: () => '',
    validate: (value, { isEdit }) => isEdit || nonEmptyText(value),
  },
  {
    kind: 'toggle',
    key: 'enabled',
    inputId: 'demo-enabled',
    testId: 'demo-enabled',
    labelKey: 'weixin.enableAccount',
    initialValue: (entity) => entity?.enabled ?? true,
  },
];

function renderFields(values: IntegrationFormValues, isEdit: boolean): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <IntegrationFormFields
        fields={demoFields}
        values={values}
        setValue={() => {}}
        isEdit={isEdit}
      />
    </I18nextProvider>
  );
}

function inputTag(html: string, testId: string): string {
  const anchor = html.indexOf(`data-testid="${testId}"`);
  expect(anchor).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<', anchor);
  const end = html.indexOf('>', anchor);
  return html.slice(start, end + 1);
}

describe('IntegrationFormFields', () => {
  test('按 schema 渲染三类字段，标签与 placeholder 走 i18n key', () => {
    const html = renderFields(integrationInitialValues(demoFields, undefined), false);

    expect(html).toContain('data-testid="demo-name-input"');
    expect(html).toContain('id="demo-name"');
    expect(html).toContain(i18n.t('weixin.accountName'));
    expect(html).toContain(i18n.t('weixin.accountNamePlaceholder'));

    expect(html).toContain('data-testid="demo-secret-input"');
    expect(html).toContain(i18n.t('telegram.botTokenPlaceholder'));

    expect(html).toContain('data-testid="demo-enabled"');
    expect(html).toContain(i18n.t('weixin.enableAccount'));
  });

  test('密钥字段渲染为 password 输入，普通文本字段不是', () => {
    const html = renderFields(integrationInitialValues(demoFields, undefined), false);

    expect(inputTag(html, 'demo-secret-input')).toContain('type="password"');
    expect(inputTag(html, 'demo-name-input')).not.toContain('type="password"');
  });

  test('编辑态 placeholder 按 isEdit 切换', () => {
    const html = renderFields(integrationInitialValues(demoFields, undefined), true);
    expect(html).toContain(i18n.t('telegram.tokenPlaceholder'));
    expect(html).not.toContain(i18n.t('telegram.botTokenPlaceholder'));
  });

  test('编辑态回填实体值，密钥字段始终留空', () => {
    const entity: DemoEntity = {
      id: 'e1',
      name: '生产账号',
      secret: 'should-not-leak',
      enabled: false,
    };
    const values = integrationInitialValues(demoFields, entity);
    expect(values).toEqual({ name: '生产账号', secret: '', enabled: false });

    const html = renderFields(values, true);
    expect(html).toContain('value="生产账号"');
    expect(html).not.toContain('should-not-leak');
  });
});

describe('开关字段的补充说明', () => {
  const toggleFields: IntegrationField<DemoEntity>[] = [
    {
      kind: 'toggle',
      key: 'allowCommands',
      inputId: 'demo-allow-commands',
      testId: 'demo-allow-commands',
      labelKey: 'telegram.allowCommands',
      descriptionKey: 'telegram.allowCommandsHelp',
      initialValue: () => false,
    },
  ];

  test('配了 descriptionKey 才渲染说明行', () => {
    const withHelp = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <IntegrationFormFields
          fields={toggleFields}
          values={{ allowCommands: false }}
          setValue={() => {}}
          isEdit={false}
        />
      </I18nextProvider>
    );
    expect(withHelp).toContain('data-testid="demo-allow-commands-help"');
    expect(renderFields(integrationInitialValues(demoFields, undefined), false)).not.toContain(
      'data-testid="demo-enabled-help"'
    );
  });

  test('两个渠道的「允许聊天指令」开关都带说明', () => {
    for (const field of [...telegramBotFormConfig.fields, ...weixinAccountFormConfig.fields]) {
      if (field.key === 'allowCommands') {
        expect(field.kind).toBe('toggle');
        expect(field.descriptionKey).toBeTruthy();
      }
    }
  });
});

describe('integrationCanSubmit', () => {
  test('必填校验未通过时拦截提交', () => {
    const empty = integrationInitialValues(demoFields, undefined);
    expect(integrationCanSubmit(demoFields, empty, { isEdit: false })).toBe(false);
    expect(integrationCanSubmit(demoFields, { ...empty, name: '   ' }, { isEdit: false })).toBe(
      false
    );
    expect(integrationCanSubmit(demoFields, { ...empty, name: 'a' }, { isEdit: false })).toBe(
      false
    );
    expect(
      integrationCanSubmit(demoFields, { ...empty, name: 'a', secret: 's' }, { isEdit: false })
    ).toBe(true);
  });

  test('编辑态密钥留空不拦截提交', () => {
    const values = integrationInitialValues(demoFields, undefined);
    expect(integrationCanSubmit(demoFields, { ...values, name: 'a' }, { isEdit: true })).toBe(true);
  });
});

describe('weixinAccountFormConfig', () => {
  test('新增载荷带 allowAuthRequests，编辑载荷不带；两者都带 allowCommands', () => {
    const values = { name: '  我的微信  ', enabled: false, allowCommands: true };
    expect(weixinAccountFormConfig.buildPayload(values, { isEdit: false })).toEqual({
      name: '我的微信',
      enabled: false,
      allowAuthRequests: true,
      allowCommands: true,
    });
    expect(weixinAccountFormConfig.buildPayload(values, { isEdit: true })).toEqual({
      name: '我的微信',
      enabled: false,
      allowCommands: true,
    });
  });

  test('allowCommands 缺省关闭，编辑态回填账号既有值', () => {
    expect(integrationInitialValues(weixinAccountFormConfig.fields, undefined).allowCommands).toBe(
      false
    );
    const account = { id: 'a1', name: '我的微信', enabled: true, allowCommands: true } as never;
    expect(integrationInitialValues(weixinAccountFormConfig.fields, account).allowCommands).toBe(
      true
    );
  });

  test('端点、查询键与校验规则', () => {
    expect(weixinAccountFormConfig.create.path).toBe('/api/settings/weixin/accounts');
    expect(weixinAccountFormConfig.create.readResponse).toBe(true);
    expect(weixinAccountFormConfig.update.path({ id: 'acc1' } as never)).toBe(
      '/api/settings/weixin/accounts/acc1'
    );
    expect(weixinAccountFormConfig.queryKey).toEqual(['weixin-accounts']);
    expect(
      integrationCanSubmit(
        weixinAccountFormConfig.fields,
        { name: '', enabled: true, allowCommands: false },
        {
          isEdit: false,
        }
      )
    ).toBe(false);
  });
});

describe('telegramBotFormConfig', () => {
  test('新增载荷带 token、enabled 与 allowCommands', () => {
    expect(
      telegramBotFormConfig.buildPayload(
        { name: ' bot ', token: ' tk ', allowAuthRequests: true, allowCommands: true },
        { isEdit: false }
      )
    ).toEqual({
      name: 'bot',
      token: 'tk',
      enabled: true,
      allowAuthRequests: true,
      allowCommands: true,
    });
  });

  test('编辑载荷仅在填写 token 时携带该字段，allowCommands 始终提交', () => {
    expect(
      telegramBotFormConfig.buildPayload(
        { name: 'bot', token: '   ', allowAuthRequests: false, allowCommands: false },
        { isEdit: true }
      )
    ).toEqual({ name: 'bot', allowAuthRequests: false, allowCommands: false });
    expect(
      telegramBotFormConfig.buildPayload(
        { name: 'bot', token: 'new-token', allowAuthRequests: false, allowCommands: true },
        { isEdit: true }
      )
    ).toEqual({
      name: 'bot',
      allowAuthRequests: false,
      allowCommands: true,
      token: 'new-token',
    });
  });

  test('allowCommands 缺省关闭，编辑态回填 bot 既有值', () => {
    expect(integrationInitialValues(telegramBotFormConfig.fields, undefined).allowCommands).toBe(
      false
    );
    const bot = { id: 'b1', name: 'bot', allowAuthRequests: true, allowCommands: true } as never;
    expect(integrationInitialValues(telegramBotFormConfig.fields, bot).allowCommands).toBe(true);
  });

  test('新增必须填 token，编辑可留空', () => {
    const fields = telegramBotFormConfig.fields;
    const base = { name: 'bot', token: '', allowAuthRequests: true, allowCommands: false };
    expect(integrationCanSubmit(fields, base, { isEdit: false })).toBe(false);
    expect(integrationCanSubmit(fields, base, { isEdit: true })).toBe(true);
    expect(integrationCanSubmit(fields, { ...base, token: 'tk' }, { isEdit: false })).toBe(true);
  });

  test('端点与查询键', () => {
    expect(telegramBotFormConfig.create.path).toBe('/api/settings/telegram/bots');
    expect(telegramBotFormConfig.create.readResponse).toBeUndefined();
    expect(telegramBotFormConfig.update.path({ id: 'b1' } as never)).toBe(
      '/api/settings/telegram/bots/b1'
    );
    expect(telegramBotFormConfig.queryKey).toEqual(['telegram-bots']);
  });
});
