import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileCategory, FileStatResponse } from '@tmex/shared';
import { basename, dirname } from '@tmex/shared';
import { Download, ExternalLink, FileWarning, Loader2, RotateCw } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import i18n from '@/i18n';
import {
  type ApiClient,
  type FileApiError,
  downloadFileWithProgress,
  fetchFileContent,
  fetchFileStat,
} from '@tmex/api-client';
import { formatBytes } from '@tmex/api-client';
import { fileRawUrl } from '@tmex/api-client';
import { CodeViewer } from '@tmex/panels/code-viewer';
import { startTransferToast } from '@tmex/panels/files';
import { MarkdownPreview } from '@tmex/panels/markdown';
import { type AppRuntime, type FileRef, decodeFileRef } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';

function useFileRef(ref?: string): FileRef | null {
  return useMemo(() => (ref ? decodeFileRef(ref) : null), [ref]);
}

// 应用内下载（与文件树菜单一致）：两段进度 Toast + 可取消；传输与宿主 save 分离。
// 传输与保存都走当前 runtime（多 node 下不能落到 entry 的 client / host）。
function triggerDownload(
  runtime: Pick<AppRuntime, 'apiClient' | 'host'>,
  rootId: string,
  path: string,
  name: string
): void {
  const controller = new AbortController();
  const tt = startTransferToast(name, 'download', () => controller.abort());
  void downloadFileWithProgress(
    rootId,
    path,
    name,
    { onLeg: tt.leg, signal: controller.signal },
    runtime.apiClient
  )
    .then((file) => runtime.host.saveFile(file))
    .then(() => tt.success(i18n.t('files.transfer.downloaded', { name })))
    .catch(() => {
      if (controller.signal.aborted) tt.cancel();
      else tt.fail(i18n.t('files.transfer.downloadFailed', { name }));
    });
}

const TEXT_CATEGORIES: ReadonlySet<FileCategory> = new Set<FileCategory>([
  'code',
  'markdown',
  'text',
]);

function CenteredMessage({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="tmex-fade flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      {icon}
      <span className="text-sm">{text}</span>
    </div>
  );
}

function errorText(error: FileApiError | null | undefined, t: (k: string) => string): string {
  if (!error) return t('file.loadFailed');
  if (error.code) return t(`files.error.${error.code}`);
  return error.message || t('file.loadFailed');
}

function DownloadFallback({
  rootId,
  path,
  name,
  text,
}: { rootId: string; path: string; name: string; text: string }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <FileWarning className="size-10 text-muted-foreground/60" />
      <span className="text-sm text-muted-foreground break-all">{text}</span>
      <Button
        variant="default"
        size="sm"
        onClick={() => triggerDownload(runtime, rootId, path, name)}
      >
        <Download className="h-4 w-4" />
        {t('file.download')}
      </Button>
    </div>
  );
}

function FallbackCard({ rootId, stat }: { rootId: string; stat: FileStatResponse }) {
  const { t } = useTranslation();
  const sizeText = stat.size > 0 ? formatBytes(stat.size) : '';
  return (
    <DownloadFallback
      rootId={rootId}
      path={stat.path}
      name={stat.name}
      text={`${t('file.notPreviewable')}${sizeText ? ` · ${sizeText}` : ''}`}
    />
  );
}

function ImageView({
  nodeId,
  rootId,
  path,
  name,
}: { nodeId: string; rootId: string; path: string; name: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto p-4">
      <img
        src={fileRawUrl(nodeId, rootId, path)}
        alt={name}
        className="max-h-full max-w-full object-contain"
        data-testid="file-image"
      />
    </div>
  );
}

function MediaView({
  nodeId,
  rootId,
  path,
  category,
}: { nodeId: string; rootId: string; path: string; category: FileCategory }) {
  if (category === 'audio') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {/* biome-ignore lint/a11y/useMediaCaption: 本地媒体文件预览，无字幕 */}
        <audio controls src={fileRawUrl(nodeId, rootId, path)} className="w-full max-w-xl" />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-4">
      {/* biome-ignore lint/a11y/useMediaCaption: 本地媒体文件预览，无字幕 */}
      <video controls src={fileRawUrl(nodeId, rootId, path)} className="max-h-full max-w-full" />
    </div>
  );
}

function PdfView({
  nodeId,
  rootId,
  path,
  name,
}: { nodeId: string; rootId: string; path: string; name: string }) {
  return (
    <iframe
      title={name}
      src={fileRawUrl(nodeId, rootId, path)}
      className="h-full w-full border-0"
    />
  );
}

function TextView({
  nodeId,
  apiClient,
  rootId,
  path,
  category,
  name,
}: {
  nodeId: string;
  apiClient: ApiClient;
  rootId: string;
  path: string;
  category: FileCategory;
  name: string;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['files', 'content', rootId, path],
    queryFn: () => fetchFileContent(rootId, path, apiClient),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <CenteredMessage
        icon={<Loader2 className="size-6 animate-spin motion-reduce:animate-none" />}
        text={t('common.loading')}
      />
    );
  }

  if (query.isError) {
    const err = query.error as FileApiError;
    if (err.code === 'too_large' || err.code === 'binary') {
      return (
        <DownloadFallback
          rootId={rootId}
          path={path}
          name={name}
          text={t(`files.error.${err.code}`)}
        />
      );
    }
    return <CenteredMessage icon={<FileWarning className="size-8" />} text={errorText(err, t)} />;
  }

  const content = query.data?.content ?? '';
  if (category === 'markdown') {
    return (
      <div className="h-full overflow-auto px-4 py-4 md:px-6">
        <MarkdownPreview
          source={content}
          basePath={dirname(path)}
          urlResolver={(imgPath) => fileRawUrl(nodeId, rootId, imgPath)}
          className="mx-auto max-w-3xl"
        />
      </div>
    );
  }
  return <CodeViewer code={content} fileName={name} className="h-full" />;
}

export default function FilePage() {
  const { ref } = useParams();
  const { nodeId, apiClient } = useRuntime();
  const fileRef = useFileRef(ref);
  const { t } = useTranslation();

  const statQuery = useQuery({
    queryKey: ['files', 'stat', fileRef?.rootId, fileRef?.path],
    queryFn: () => fetchFileStat(fileRef?.rootId as string, fileRef?.path as string, apiClient),
    enabled: Boolean(fileRef),
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!fileRef) {
    return (
      <CenteredMessage icon={<FileWarning className="size-8" />} text={t('file.invalidRef')} />
    );
  }

  if (statQuery.isLoading) {
    return (
      <CenteredMessage
        icon={<Loader2 className="size-6 animate-spin motion-reduce:animate-none" />}
        text={t('common.loading')}
      />
    );
  }

  if (statQuery.isError) {
    return (
      <CenteredMessage
        icon={<FileWarning className="size-8" />}
        text={errorText(statQuery.error as FileApiError, t)}
      />
    );
  }

  const stat = statQuery.data;
  if (!stat) {
    return (
      <CenteredMessage icon={<FileWarning className="size-8" />} text={t('file.loadFailed')} />
    );
  }
  if (stat.type === 'dir' || stat.category === 'directory') {
    return <CenteredMessage text={t('file.isDirectory')} />;
  }

  const { rootId, path } = fileRef;
  switch (stat.category) {
    case 'image':
      return <ImageView nodeId={nodeId} rootId={rootId} path={path} name={stat.name} />;
    case 'pdf':
      return <PdfView nodeId={nodeId} rootId={rootId} path={path} name={stat.name} />;
    case 'audio':
    case 'video':
      return <MediaView nodeId={nodeId} rootId={rootId} path={path} category={stat.category} />;
    default:
      if (TEXT_CATEGORIES.has(stat.category)) {
        return (
          <TextView
            nodeId={nodeId}
            apiClient={apiClient}
            rootId={rootId}
            path={path}
            category={stat.category}
            name={stat.name}
          />
        );
      }
      return <FallbackCard rootId={rootId} stat={stat} />;
  }
}

export function PageTitle({ ref }: { ref?: string }) {
  const fileRef = ref ? decodeFileRef(ref) : null;
  return <span className="truncate font-mono">{fileRef ? basename(fileRef.path) : ''}</span>;
}

export function PageActions({ ref }: { ref?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const runtime = useRuntime();
  const nodeId = runtime.nodeId;
  const fileRef = ref ? decodeFileRef(ref) : null;
  if (!fileRef) return null;
  const { rootId, path } = fileRef;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['files', 'stat', rootId, path] });
    void queryClient.invalidateQueries({ queryKey: ['files', 'content', rootId, path] });
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={refresh}
        title={t('common.refresh')}
        data-testid="file-refresh"
      >
        <RotateCw className="h-4 w-4" />
      </Button>
      <a
        href={fileRawUrl(nodeId, rootId, path)}
        target="_blank"
        rel="noopener noreferrer"
        title={t('file.openRaw')}
      >
        <Button variant="ghost" size="icon-sm">
          <ExternalLink className="h-4 w-4" />
        </Button>
      </a>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="file-download-action"
        title={t('file.download')}
        onClick={() => triggerDownload(runtime, rootId, path, basename(path))}
      >
        <Download className="h-4 w-4" />
      </Button>
    </>
  );
}
