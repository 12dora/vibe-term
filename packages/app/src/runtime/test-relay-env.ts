// 测试用：gateway config 在模块加载时快照 env，中继相关变量必须先于它设好。
if (!process.env.TMEX_RELAY_PUBLIC_URL) {
  process.env.TMEX_RELAY_PUBLIC_URL = 'http://127.0.0.1:19993';
}
if (!process.env.TMEX_RELAY_ADMIN_TOKEN) {
  process.env.TMEX_RELAY_ADMIN_TOKEN = 'assemble-test-relay-admin-token';
}
