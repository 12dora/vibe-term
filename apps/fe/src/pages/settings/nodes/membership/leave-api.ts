// 退出 mesh 的接口边界。
//
// 实现就是 api-client 的 `LocalApi.leave()`（`POST /api/local/leave`，契约见
// `prompt-archives/2026082901-nodes-settings-devices-polish/sub/api-contract.md`）；
// 这里只留一个窄接口，让 hook 的依赖可注入、可替换，同时把角色收敛到 `MeshRole`。

import { defaultLocalApi } from '@tmex/api-client/local/local-api';
import type { LocalLeaveResponse } from '@tmex/api-client/local/types';
import type { MeshRole } from './role-transition';

export interface LocalLeaveRequest {
  /** 必须与当前角色一致，否则后端 409 `role_mismatch`。 */
  expectedRole: MeshRole;
}

export type { LocalLeaveResponse };

export interface LeaveApi {
  leave(body: LocalLeaveRequest): Promise<LocalLeaveResponse>;
}

export const defaultLeaveApi: LeaveApi = defaultLocalApi;
