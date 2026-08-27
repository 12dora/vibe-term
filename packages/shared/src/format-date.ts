// 按站点语言渲染日期/时间：非法或缺省值统一返回空串，占位文案交给调用方。

import { type LocaleCode, toBCP47 } from './i18n/resources';

export type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: DateInput, language: string): string {
  const date = toDate(value);
  return date ? date.toLocaleString(toBCP47(language as LocaleCode)) : '';
}

export function formatDate(value: DateInput, language: string): string {
  const date = toDate(value);
  return date ? date.toLocaleDateString(toBCP47(language as LocaleCode)) : '';
}
