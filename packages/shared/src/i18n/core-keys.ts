// 首屏语言包（core）与其余语言包（rest）的切分依据。
// core 覆盖入口 chunk 能触发的全部 key：外壳、侧边栏、终端事件、通知、鉴权错误。
// 其余命名空间（settings / nodes / connectDevices / telegram / weixin / files 详情等）只出现在
// 懒路由与懒面板里，进 rest 包，由 `apps/fe/src/i18n` 在首帧后预取、并由懒路由 loader 显式 await。
// 改动这里必须重新跑 `bun run build:i18n` 生成 locales/generated/*.json；
// apps/fe/src/i18n/core-coverage.test.ts 会用静态 import 图复核 core 是否漏项。

export const I18N_CORE_KEY_PREFIXES: readonly string[] = [
  'agent',
  // 主密钥失配的常驻提示挂在外壳上（登录页也要看得到），整块进 core。
  'app.masterKeyMismatch',
  'appError',
  'auth.credential',
  'auth.duration',
  'auth.errors',
  'auth.login',
  'auth.node',
  // 安全面板本体（含登录限制设置）是懒面板，外壳只用到它的标题。
  'auth.security.title',
  'auth.totpDigit',
  'common',
  'device',
  'deviceStatus',
  'files',
  'nav',
  // 上面那条提示复用了节点设置里的复制按钮，只把它用到的两个 key 提上来。
  'nodes.actions.copied',
  'nodes.actions.copy',
  // 节点地址/离线相对时间的纯函数被入口图引用（merge-nodes → node-address），4 个时间 key 提上来。
  'nodes.time',
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

/** 按前缀表判定 key 是否命中：等于前缀，或以 `前缀.` / `前缀_`（复数后缀）开头。 */
export function matchesI18nPrefix(prefixes: readonly string[], key: string): boolean {
  return prefixes.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}_`)
  );
}

/** 按谓词把一棵翻译树拆成互斥的两棵（matched / rest），叶子总数守恒。 */
export function partitionTranslation(
  tree: TranslationTree,
  isMatch: (key: string) => boolean
): { matched: TranslationTree; rest: TranslationTree } {
  const walk = (
    node: TranslationTree,
    path: string,
    matchedOut: TranslationTree,
    restOut: TranslationTree
  ): void => {
    for (const [key, value] of Object.entries(node)) {
      const full = path ? `${path}.${key}` : key;
      const hit = isMatch(full);
      if (typeof value === 'string' || hit) {
        (hit ? matchedOut : restOut)[key] = value;
        continue;
      }
      const nestedMatched: TranslationTree = {};
      const nestedRest: TranslationTree = {};
      walk(value, full, nestedMatched, nestedRest);
      if (Object.keys(nestedMatched).length > 0) matchedOut[key] = nestedMatched;
      if (Object.keys(nestedRest).length > 0) restOut[key] = nestedRest;
    }
  };

  const matched: TranslationTree = {};
  const rest: TranslationTree = {};
  walk(tree, '', matched, rest);
  return { matched, rest };
}

/** 按 `I18N_CORE_KEY_PREFIXES` 把一棵翻译树拆成互斥的两棵，叶子总数守恒。 */
export function splitTranslation(tree: TranslationTree): SplitTranslation {
  const { matched, rest } = partitionTranslation(tree, isCoreI18nKey);
  return { core: matched, rest };
}
