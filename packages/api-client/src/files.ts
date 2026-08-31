// 文件模块门面：保持既有 import 路径，实现拆分在 REST 端点、上传/下载传输与 NDJSON 分帧四个模块中。

export { FileApiError } from './file-errors';
export {
  browseDirectory,
  createFileRoot,
  deleteFileRoot,
  fetchFileContent,
  fetchFileList,
  fetchFileRoots,
  fetchFileStat,
  reorderFileRoots,
  updateFileRoot,
} from './file-resources';
export { uploadFileChunked } from './upload-transfer';
export { downloadFileWithProgress, type DownloadedFile } from './download-transfer';
export type { LegProgress, OnLeg } from './transfer-types';
