import { fileBrowserRoutes } from './file-browser-routes';
import { fileRootRoutes } from './file-root-routes';
import { fileTransferRoutes } from './file-transfer-routes';
import type { ApiRoute } from './route';

export const filesRoutes: ApiRoute[] = [
  ...fileRootRoutes,
  ...fileBrowserRoutes,
  ...fileTransferRoutes,
];
