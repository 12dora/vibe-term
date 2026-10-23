import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileCategory, FileEntryDto } from '@vibeterm/shared';
import { basename, dirname } from '@vibeterm/shared';
import { ArrowLeft, Download, ExternalLink, FileWarning, Loader2, RotateCw } from 'lucide-react';
import { type ReactNode, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { lazyChunk } from '@/lazy-chunk';
import {
  type ApiClient,
  type FileApiError,
  fetchFileContent,
  fileRawUrl,
  formatBytes,
} from '@vibeterm/api-client';
import { CodeViewer } from '@vibeterm/panels/code-viewer';
import { downloadSingleFile } from '@vibeterm/panels/files/transfer-flows';
import { type FileRef, decodeFileRef } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';
import { Button } from '@vibeterm/ui/button';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { backToFileManager } from './file/back-to-manager';
import { fileEntryFromStat } from './file/file-entry';
import { SiblingHeaderButtons } from './file/header-arrows';
import { TEXT_CATEGORIES } from './file/preview-categories';
import { PreviewFrame } from './file/preview-frame';
import { useFileStat } from './file/use-file-stat';

// Markdown 渲染链（react-markdown + katex + mermaid 等）约 137 KiB gzip，只有 markdown 文件用得到，
// 代码 / 纯文本预览不该为它买单。
const MarkdownPreview = lazyChunk(() =>
  import('@vibeterm/panels/markdown').then((m) => m.MarkdownPreview)
);

function useFileRef(ref?: string): FileRef | null {
  return useMemo(() => (ref ? decodeFileRef(ref) : null), [ref]);
}

function CenteredMessage({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <div className="vibeterm-fade flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
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
  entry,
  text,
}: { rootId: string; entry: FileEntryDto; text: string }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <FileWarning className="size-10 text-muted-foreground/60" />
      <span className="text-sm text-muted-foreground break-all">{text}</span>
      <Button
        variant="default"
        size="sm"
        onClick={() => void downloadSingleFile({ runtime, t, rootId }, entry)}
      >
        <Download className="h-4 w-4" />
        {t('file.download')}
      </Button>
    </div>
  );
}

function FallbackCard({ rootId, entry }: { rootId: string; entry: FileEntryDto }) {
  const { t } = useTranslation();
  const sizeText = entry.size ? formatBytes(entry.size) : '';
  return (
    <DownloadFallback
      rootId={rootId}
      entry={entry}
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
  entry,
}: {
  nodeId: string;
  apiClient: ApiClient;
  rootId: string;
  entry: FileEntryDto;
}) {
  const { t } = useTranslation();
  const { path, name, category } = entry;
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
      return <DownloadFallback rootId={rootId} entry={entry} text={t(`files.error.${err.code}`)} />;
    }
    return <CenteredMessage icon={<FileWarning className="size-8" />} text={errorText(err, t)} />;
  }

  const content = query.data?.content ?? '';
  if (category === 'markdown') {
    return (
      <div className="h-full overflow-auto px-4 py-4 md:px-6">
        <Suspense
          fallback={
            <CenteredMessage
              icon={<Loader2 className="size-6 animate-spin motion-reduce:animate-none" />}
              text={t('common.loading')}
            />
          }
        >
          <MarkdownPreview
            source={content}
            basePath={dirname(path)}
            urlResolver={(imgPath) => fileRawUrl(nodeId, rootId, imgPath)}
            className="mx-auto max-w-3xl"
          />
        </Suspense>
      </div>
    );
  }
  return <CodeViewer code={content} fileName={name} className="h-full" />;
}

function PreviewBody({ fileRef, entry }: { fileRef: FileRef; entry: FileEntryDto }) {
  const { nodeId, apiClient } = useRuntime();
  const { rootId, path } = fileRef;
  switch (entry.category) {
    case 'image':
      return <ImageView nodeId={nodeId} rootId={rootId} path={path} name={entry.name} />;
    case 'pdf':
      return <PdfView nodeId={nodeId} rootId={rootId} path={path} name={entry.name} />;
    case 'audio':
    case 'video':
      return <MediaView nodeId={nodeId} rootId={rootId} path={path} category={entry.category} />;
    default:
      if (TEXT_CATEGORIES.has(entry.category)) {
        return <TextView nodeId={nodeId} apiClient={apiClient} rootId={rootId} entry={entry} />;
      }
      return <FallbackCard rootId={rootId} entry={entry} />;
  }
}

/** stat 的加载 / 失败 / 目录都在这里换内容；外层 PreviewFrame 不随之卸载。 */
function StatContent({
  fileRef,
  statQuery,
}: { fileRef: FileRef; statQuery: ReturnType<typeof useFileStat> }) {
  const { t } = useTranslation();
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
  return <PreviewBody fileRef={fileRef} entry={fileEntryFromStat(stat, fileRef.path)} />;
}

export default function FilePage() {
  const { ref } = useParams();
  const fileRef = useFileRef(ref);
  const { t } = useTranslation();
  const statQuery = useFileStat(fileRef);

  if (!fileRef) {
    return (
      <CenteredMessage icon={<FileWarning className="size-8" />} text={t('file.invalidRef')} />
    );
  }
  return (
    <PreviewFrame fileRef={fileRef} category={statQuery.data?.category}>
      <StatContent fileRef={fileRef} statQuery={statQuery} />
    </PreviewFrame>
  );
}

export function PageTitle({ ref }: { ref?: string }) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const fileRef = ref ? decodeFileRef(ref) : null;
  if (!fileRef) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <IconTooltip label={t('file.back')}>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => backToFileManager(runtime, fileRef)}
          aria-label={t('file.back')}
          data-testid="file-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </IconTooltip>
      <span className="truncate font-mono">{basename(fileRef.path)}</span>
    </span>
  );
}

export function PageActions({ ref }: { ref?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const runtime = useRuntime();
  const nodeId = runtime.nodeId;
  const fileRef = ref ? decodeFileRef(ref) : null;
  const stat = useFileStat(fileRef).data;
  if (!fileRef) return null;
  const { rootId, path } = fileRef;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['files', 'stat', rootId, path] });
    void queryClient.invalidateQueries({ queryKey: ['files', 'content', rootId, path] });
  };
  const download = () => {
    if (stat) void downloadSingleFile({ runtime, t, rootId }, fileEntryFromStat(stat, path));
  };

  return (
    <>
      <SiblingHeaderButtons fileRef={fileRef} category={stat?.category} />
      <IconTooltip label={t('common.refresh')}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          aria-label={t('common.refresh')}
          data-testid="file-refresh"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      </IconTooltip>
      <IconTooltip label={t('file.openRaw')}>
        <a
          href={fileRawUrl(nodeId, rootId, path)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('file.openRaw')}
          className="inline-flex"
        >
          <Button variant="ghost" size="icon-sm" tabIndex={-1}>
            <ExternalLink className="h-4 w-4" />
          </Button>
        </a>
      </IconTooltip>
      <IconTooltip label={t('file.download')}>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!stat}
          data-testid="file-download-action"
          aria-label={t('file.download')}
          onClick={download}
        >
          <Download className="h-4 w-4" />
        </Button>
      </IconTooltip>
    </>
  );
}
