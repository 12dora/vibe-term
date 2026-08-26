// 微信（iLink）通知渠道契约

export interface WeixinAccountConfig {
  id: string;
  name: string;
  enabled: boolean;
  allowAuthRequests: boolean;
  /** 是否已扫码登录（持有 iLink 凭证）。 */
  loggedIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WeixinAccountWithStats extends WeixinAccountConfig {
  pendingCount: number;
  authorizedCount: number;
  /** 会话已过期、需用户重新发消息激活的授权用户数。 */
  needsReactivationCount: number;
}

export type WeixinUserStatus = 'pending' | 'authorized';

export interface WeixinAccountUser {
  id: string;
  accountId: string;
  userId: string;
  displayName: string;
  status: WeixinUserStatus;
  /** 半主动推送语义：iLink 会话已过期、需用户重新发消息激活。 */
  needsReactivation: boolean;
  lastInboundAt: string | null;
  appliedAt: string;
  authorizedAt: string | null;
  updatedAt: string;
}

export type WeixinLoginStatus = 'pending' | 'confirmed' | 'expired' | 'error';

export interface ListWeixinAccountsResponse {
  accounts: WeixinAccountWithStats[];
}

export interface CreateWeixinAccountRequest {
  name: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
}

export interface UpdateWeixinAccountRequest {
  name?: string;
  enabled?: boolean;
  allowAuthRequests?: boolean;
}

export interface ListWeixinAccountUsersResponse {
  users: WeixinAccountUser[];
}

export interface StartWeixinLoginResponse {
  /** 二维码内容（前端渲染成二维码图）。 */
  qrcodeUrl: string;
  /** 轮询扫码状态用的标识。 */
  qrcodeId: string;
}

export interface WeixinLoginStatusResponse {
  status: WeixinLoginStatus;
  loggedIn: boolean;
  message?: string;
}
