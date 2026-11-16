import { enRuntime } from './en-runtime';

export type CliLang = 'en' | 'zh-CN';

type Vars = Record<string, string | number | boolean | undefined>;
type Tables = Record<CliLang, Record<string, string>>;

let currentLang: CliLang = 'en';
let fullTables: Tables | null = null;

// 常驻运行时只用 enRuntime；CLI 全量文案与帮助首次需要时才同步加载，不进启动链。
function loadFullTables(): Tables {
  if (!fullTables) {
    const { en } = require('./en') as typeof import('./en');
    const { zhCN } = require('./zh-cn') as typeof import('./zh-cn');
    fullTables = { en, 'zh-CN': zhCN };
  }
  return fullTables;
}

export function normalizeLang(input: string | undefined): CliLang {
  if (!input) return 'en';

  const raw = input.trim();
  if (!raw) return 'en';

  const lower = raw.toLowerCase();
  if (lower === 'en' || lower === 'en-us' || lower === 'en_us') return 'en';
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh_cn' || lower === 'cn') return 'zh-CN';

  return 'en';
}

export function setLang(lang: CliLang): void {
  currentLang = lang;
}

function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
}

export function t(key: string, vars?: Vars): string {
  if (key === 'cli.help') {
    const { cliHelpText } = require('../cli/help') as typeof import('../cli/help');
    return cliHelpText(currentLang);
  }
  if (currentLang === 'en') {
    const hit = enRuntime[key];
    if (hit !== undefined) return interpolate(hit, vars);
  }
  const tables = loadFullTables();
  const table = tables[currentLang] ?? tables.en;
  const template = table[key] ?? tables.en[key] ?? key;
  return interpolate(template, vars);
}
