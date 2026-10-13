import { fileArchiveRoutes } from './file-archive';
import { fileBrowserRoutes } from './file-browser-routes';
import { fileDeleteRoutes } from './file-delete';
import { fileMoveRoutes } from './file-move';
import { fileRootRoutes } from './file-root-routes';
import { fileTransferRoutes } from './file-transfer-routes';
import type { ApiRoute } from './route';

export type { BulkTransferOwner, FilesBulkHooks } from './file-transfer-sessions';
export {
  abortTransfer,
  appendUpload,
  filesBulkHooks,
  getTransferOwner,
  openDownload,
} from './file-transfer-sessions';

export const filesRoutes: ApiRoute[] = [
  ...fileRootRoutes,
  ...fileBrowserRoutes,
  ...fileTransferRoutes,
  ...fileDeleteRoutes,
  ...fileMoveRoutes,
  ...fileArchiveRoutes,
];
