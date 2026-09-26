// 旧入口：登出 / 重新登录时清空直连熔断。熔断本体在 `direct-breaker.ts`。
export { resetDirectBreakers as resetDirectAuthorizeBreakers } from './direct-breaker';
