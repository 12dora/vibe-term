import { getSiteNameFallback } from './site-fallback';

interface TerminalLabelInput {
  paneIdx?: number | null;
  windowIdx?: number | null;
  paneCustomName?: string | null;
  paneTitle?: string | null;
  windowName?: string | null;
  windowCustomName?: string | null;
  deviceName?: string | null;
}

const TEXT_VARIATION_SELECTOR = '\uFE0E';
const EMOJI_VARIATION_SELECTOR = '\uFE0F';
const COMBINING_KEYCAP = '\u20E3';

const HAS_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const IS_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const IS_EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

// 标题重渲染很频繁，按码点缓存分类结果
const textPresentationCache = new Map<string, boolean>();

function needsTextVariationSelector(char: string): boolean {
  const cached = textPresentationCache.get(char);
  if (cached !== undefined) return cached;
  const result = IS_PICTOGRAPHIC.test(char) && !IS_EMOJI_PRESENTATION.test(char);
  textPresentationCache.set(char, result);
  return result;
}

/**
 * 显示层字形归一：`✳ ✶ ✻` 这类 `Extended_Pictographic=Yes` 但 `Emoji_Presentation=No`
 * 的字符，iOS 仍按遗留行为用 Apple Color Emoji 渲染成彩色图标（Claude Code 的标题/转圈字符
 * 就会变成绿色星号）。这里补 U+FE0E 强制文本呈现；已跟着 FE0F/FE0E/20E3 的有意 emoji 序列
 * 与本身就是 emoji 呈现的字符（🚀）保持原样。**仅用于展示**，不得用于标识符或回传服务端。
 */
export function forceTextPresentation(text: string): string {
  if (!text || !HAS_PICTOGRAPHIC.test(text)) return text;
  const chars = [...text];
  let out = '';
  let changed = false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    out += char;
    if (!needsTextVariationSelector(char)) continue;
    const next = chars[i + 1];
    if (next === EMOJI_VARIATION_SELECTOR || next === TEXT_VARIATION_SELECTOR) continue;
    if (next === COMBINING_KEYCAP) continue;
    out += TEXT_VARIATION_SELECTOR;
    changed = true;
  }
  return changed ? out : text;
}

function toSafeText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? forceTextPresentation(trimmed) : '?';
}

// window/pane 编号对用户无意义，标题只呈现名称与设备
export function buildTerminalLabel({
  paneCustomName,
  paneTitle,
  windowName,
  windowCustomName,
  deviceName,
}: TerminalLabelInput): string {
  const safePaneTitle = toSafeText(paneCustomName ?? windowCustomName ?? paneTitle ?? windowName);
  const safeDeviceName = toSafeText(deviceName);
  return `${safePaneTitle}@${safeDeviceName}`;
}

interface WindowTitleInput {
  name: string;
  customName?: string | null;
  panes: Array<{ active: boolean; title?: string | null }>;
}

export interface WindowTitleParts {
  /** 展示用标题（已做字形归一），不要回传服务端 */
  title: string;
  /** 未归一的原始标题，供重命名等需要回写 tmux 的场景做初值 */
  rawTitle: string;
  processName?: string;
}

export function buildWindowTitleParts(window: WindowTitleInput): WindowTitleParts {
  const customName = window.customName?.trim();
  const activePane = window.panes.find((pane) => pane.active) ?? window.panes[0];
  const processName = window.name.trim();
  const oscTitle = activePane?.title?.trim();
  const rawTitle = customName || oscTitle || processName;
  // 标题已经是进程名时不重复展示
  const showProcess = Boolean(processName) && processName !== rawTitle;
  return {
    title: forceTextPresentation(rawTitle),
    rawTitle,
    processName: showProcess ? forceTextPresentation(processName) : undefined,
  };
}

export function buildWindowDisplayName(window: WindowTitleInput): string {
  const { title, processName } = buildWindowTitleParts(window);
  return processName ? `${processName}: ${title}` : title;
}

export function buildBrowserTitle(label?: string | null): string {
  const siteName = getSiteNameFallback();
  if (!label?.trim()) {
    return siteName;
  }
  return `[${forceTextPresentation(siteName)}]${forceTextPresentation(label)}`;
}
