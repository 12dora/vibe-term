// 目录节点的上传入口：外部文件拖入 + 右键菜单选择文件，逐文件分块上传并显示可取消的进度 Toast。

import { useQueryClient } from '@tanstack/react-query';
import { formatBytes, uploadFileChunked } from '@tmex/api-client';
import { useFileTreeStore, useRuntime } from '@tmex/stores/react';
import { type ChangeEvent, type DragEvent, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { dataTransferHasFiles, planUpload } from './file-tree-logic';
import { startTransferToast } from './transfer-toast';

export function hasExternalFiles(e: DragEvent): boolean {
  return dataTransferHasFiles(e.dataTransfer.types);
}

export interface DropZoneProps {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export interface DirectoryUpload {
  /** 拖拽悬停在本目录上（用于高亮） */
  dragActive: boolean;
  dropZoneProps: DropZoneProps;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  openFilePicker: () => void;
  handleFileInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

export function useDirectoryUpload(
  rootId: string,
  path: string,
  transferMaxBytes: number
): DirectoryUpload {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const expand = useFileTreeStore((s) => s.expand);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const resetDrag = useCallback(() => {
    dragDepth.current = 0;
    setDragActive(false);
  }, []);

  // 上传到本目录：逐文件分块上传 + 进度 Toast（可取消）；完成后展开并刷新该目录列表。
  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const { accepted, oversized } = planUpload(files, transferMaxBytes);
      for (const file of oversized) {
        toast.error(
          t('files.transfer.tooLarge', { name: file.name, max: formatBytes(transferMaxBytes) })
        );
      }
      for (const file of accepted) {
        const controller = new AbortController();
        const tt = startTransferToast(file.name, 'upload', () => controller.abort());
        try {
          await uploadFileChunked(
            rootId,
            path,
            file,
            { onLeg: tt.leg, signal: controller.signal },
            runtime.apiClient
          );
          tt.success(t('files.upload.success', { name: file.name }));
        } catch {
          if (controller.signal.aborted) tt.cancel();
          else tt.fail(t('files.upload.fail', { name: file.name }));
        }
      }
      expand(rootId, path);
      void queryClient.invalidateQueries({ queryKey: ['files', 'list', rootId, path] });
    },
    [expand, path, queryClient, rootId, runtime.apiClient, t, transferMaxBytes]
  );

  const dropZoneProps: DropZoneProps = {
    onDragEnter: (e) => {
      if (!hasExternalFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    },
    onDragOver: (e) => {
      if (!hasExternalFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e) => {
      if (!hasExternalFiles(e)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) resetDrag();
    },
    onDrop: (e) => {
      if (!hasExternalFiles(e)) return;
      e.preventDefault();
      resetDrag();
      void upload(Array.from(e.dataTransfer.files));
    },
  };

  return {
    dragActive,
    dropZoneProps,
    fileInputRef,
    openFilePicker: useCallback(() => fileInputRef.current?.click(), []),
    handleFileInputChange: useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        void upload(files);
      },
      [upload]
    ),
  };
}
