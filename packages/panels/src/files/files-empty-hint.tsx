// 文件侧栏的空态：目录不在设置页配置了（入口是「管理设备」→ 设备卡片 ⋯ →「文件」），
// 一个目录都没配过时给一条带链接的提示。
//
// 单 node 宿主由 `FilesNodeRoots` 直接渲染提示；多 node 宿主各分节在空时整节不渲染，
// 提示只能由外壳出一条——各分节把自己的状态报到 `FilesSectionStateProvider`，外壳据此判断。

import { hostAppPath } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/** 一个分节此刻的成色：`content` 指分节确实渲染了东西（目录、错误、离线或登录入口）。 */
export type FilesSectionState = 'loading' | 'unconfigured' | 'empty' | 'content';

/**
 * 单个分节的成色。`unconfigured` 专指「这台 node 一个目录都没配过」，
 * 与「配过但被侧栏开关隐藏 / 所属设备没连上」（`empty`）分开——后者不该劝用户去配置。
 */
export function filesSectionState(
  query: { isError: boolean; isSuccess: boolean },
  configuredCount: number,
  visibleCount: number
): FilesSectionState {
  if (query.isError) return 'content';
  if (!query.isSuccess) return 'loading';
  if (visibleCount > 0) return 'content';
  return configuredCount === 0 ? 'unconfigured' : 'empty';
}

/**
 * 外壳出哪条提示：全部分节都加载完、都没内容时才出。至少有一台确实没配过目录就劝去配置，
 * 否则（配过但全被开关隐藏 / 设备没连上）与单 node 一样只说没得显示，不留一片空白。
 */
export function filesTabEmptyHint(
  states: readonly FilesSectionState[]
): 'noRoots' | 'noVisibleRoots' | null {
  if (states.length === 0) return null;
  if (states.some((state) => state === 'loading' || state === 'content')) return null;
  return states.includes('unconfigured') ? 'noRoots' : 'noVisibleRoots';
}

type ReportSection = (id: string, state: FilesSectionState | null) => void;

const FilesSectionStateContext = createContext<ReportSection | null>(null);

export function FilesSectionStateProvider({
  report,
  children,
}: { report: ReportSection; children: ReactNode }) {
  return (
    <FilesSectionStateContext.Provider value={report}>{children}</FilesSectionStateContext.Provider>
  );
}

/** 分节把自己的成色报给外壳；卸载时销号。外壳没提供上下文（单 node）时是空操作。 */
export function useReportFilesSection(id: string, state: FilesSectionState): void {
  const report = useContext(FilesSectionStateContext);
  useEffect(() => {
    if (!report) return;
    report(id, state);
    return () => report(id, null);
  }, [report, id, state]);
}

export function useFilesSectionStates(): {
  report: ReportSection;
  states: FilesSectionState[];
} {
  const [byId, setById] = useState<Record<string, FilesSectionState>>({});
  const report = useCallback<ReportSection>((id, state) => {
    setById((prev) => {
      if (state === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if (prev[id] === state) return prev;
      return { ...prev, [id]: state };
    });
  }, []);
  return { report, states: Object.values(byId) };
}

/** 配过目录但一个都不显示：单 node 文件树与 mesh 外壳共用。 */
export function FilesNoVisibleRootsHint() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="files-no-visible-roots-hint"
      className="px-3 py-6 text-center text-xs text-muted-foreground"
    >
      {t('files.noVisibleRoots')}
    </div>
  );
}

/** 「未配置目录」提示：「管理设备」是链接，其余是路径说明。 */
export function FilesNoRootsHint() {
  const { host } = useRuntime();
  return (
    <div
      data-testid="files-no-roots-hint"
      className="px-3 py-6 text-center text-xs text-muted-foreground"
    >
      <Trans
        i18nKey="files.noRoots"
        components={{
          manage: (
            <Link
              to={hostAppPath(host, '/devices')}
              data-testid="files-no-roots-manage-link"
              className="text-primary underline underline-offset-2"
            />
          ),
        }}
      />
    </div>
  );
}
