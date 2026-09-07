import { cliHelpText } from '../cli/help';
import { en } from './en';
import { zhCN } from './zh-cn';

export type CliLang = 'en' | 'zh-CN';

type Vars = Record<string, string | number | boolean | undefined>;

const MESSAGES: Record<CliLang, Record<string, string>> = { en, 'zh-CN': zhCN };

let currentLang: CliLang = 'en';

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
    return cliHelpText(currentLang);
  }
  const table = MESSAGES[currentLang] ?? MESSAGES.en;
  const fallback = MESSAGES.en[key];
  const template = table[key] ?? fallback ?? key;
  return interpolate(template, vars);
}
