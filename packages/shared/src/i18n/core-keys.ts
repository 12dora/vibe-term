// 首屏语言包（core）与其余语言包（rest）的切分依据。
// core 覆盖入口 chunk 能触发的全部 key：外壳、侧边栏、终端事件、通知、鉴权错误。
// 其余命名空间（settings / nodes / connectDevices / telegram / weixin / files 详情等）只出现在
// 懒路由与懒面板里，进 rest 包，由 `apps/fe/src/i18n` 在首帧后预取、并由懒路由 loader 显式 await。
// 改动这里必须重新跑 `bun run build:i18n` 生成 locales/generated/*.json；
// apps/fe/src/i18n/core-coverage.test.ts 会用静态 import 图复核 core 是否漏项。

export const I18N_CORE_KEY_PREFIXES: readonly string[] = [
  'agent',
  'appError',
  'auth',
  'common',
  'device',
  'deviceStatus',
  'files',
  'nav',
  'notification',
  'settings.terminal.loadFailed',
  'settings.terminal.loadFailedHint',
  'settings.terminal.loading',
  'settings.terminal.reloadApp',
  'settings.theme',
  'settings.themeDark',
  'settings.themeLight',
  'shareAccess',
  'sidebar',
  'terminal',
  'watch',
  'websocket',
  'window',
];

export function isCoreI18nKey(key: string): boolean {
  return I18N_CORE_KEY_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

export type TranslationTree = { [key: string]: string | TranslationTree };

export interface SplitTranslation {
  core: TranslationTree;
  rest: TranslationTree;
}

/** 按 `I18N_CORE_KEY_PREFIXES` 把一棵翻译树拆成互斥的两棵，叶子总数守恒。 */
export function splitTranslation(tree: TranslationTree): SplitTranslation {
  const core: TranslationTree = {};
  const rest: TranslationTree = {};

  const walk = (
    node: TranslationTree,
    path: string,
    coreOut: TranslationTree,
    restOut: TranslationTree
  ): void => {
    for (const [key, value] of Object.entries(node)) {
      const full = path ? `${path}.${key}` : key;
      const target = isCoreI18nKey(full) ? coreOut : null;
      if (typeof value === 'string') {
        (target ?? restOut)[key] = value;
        continue;
      }
      if (target) {
        target[key] = value;
        continue;
      }
      const nestedCore: TranslationTree = {};
      const nestedRest: TranslationTree = {};
      walk(value, full, nestedCore, nestedRest);
      if (Object.keys(nestedCore).length > 0) coreOut[key] = nestedCore;
      if (Object.keys(nestedRest).length > 0) restOut[key] = nestedRest;
    }
  };

  walk(tree, '', core, rest);
  return { core, rest };
}
