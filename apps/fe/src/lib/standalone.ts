// 安装为 PWA（iOS 添加到主屏 / Android 安装）后启动的判定：
// iOS 16 之前只有 navigator.standalone，之后与 Android 一致支持 display-mode 媒体查询。
type StandaloneWindow = {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: { standalone?: boolean };
};

const STANDALONE_QUERY = '(display-mode: standalone)';

export function isStandaloneDisplay(
  win: StandaloneWindow | undefined = globalThis.window as unknown as StandaloneWindow | undefined
): boolean {
  if (!win) return false;
  if (win.matchMedia?.(STANDALONE_QUERY).matches === true) return true;
  return win.navigator?.standalone === true;
}

export type SidebarLaunchInput = {
  isMobile: boolean;
  standalone: boolean;
  /** 本次加载**落地**的路径，不是当前路径：启动后再导航到首页不该补弹抽屉。 */
  launchPathname: string;
  alreadyFired: boolean;
};

/**
 * PWA 冷启动落在首页时，手机端直接把侧边栏抽屉打开（终端 / 智能体 / 文件），
 * 而不是停在设备页。深链（`/n/<id>/...`、`/settings` 等）保持原样。
 *
 * `isMobile` 由媒体查询给出，首帧可能还是 false，所以判定要允许晚到；
 * 但落地路径只看启动那一次，后续路由变化不会重新满足条件。
 */
export function shouldOpenSidebarOnLaunch(input: SidebarLaunchInput): boolean {
  if (input.alreadyFired) return false;
  if (!input.isMobile || !input.standalone) return false;
  return input.launchPathname === '/' || input.launchPathname === '';
}
