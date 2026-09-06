// 仓库根测试 preload（根 bunfig.toml 引用）。
// 覆盖「从根目录直接 bun test <path>」——这种调用不走某个 workspace 的 bunfig。
// 用相对路径导入：根 node_modules 无 @vibeterm/shared 的 workspace symlink。
import { loadEnv } from '../../packages/shared/src/env/load-env';

// 生产安装目录标记：`tmex` 是改名前的目录名，已有安装原地升级后仍在旧目录，必须继续识别。
const PROD_MARKERS = [
  'Application Support/vibeterm',
  'Application Support/tmex',
  '.local/share/vibeterm',
  '.local/share/tmex',
];

// 单元测试接线键：未设或继承到生产库标记时强制内存库，杜绝写入继承的生产库。
// 显式给定的非生产测试路径则保留。
const db = process.env.DATABASE_URL;
if (!db || PROD_MARKERS.some((marker) => db.includes(marker))) {
  process.env.DATABASE_URL = ':memory:';
}

// bun test 已将 NODE_ENV 设为 test：loadEnv 命中 test.env，并净化继承的安装版路径键。
loadEnv();

// 这里刻意不挂 packages/app 的主目录沙箱。实测 bun 1.3.14：preload 里的 `Bun.argv` /
// `process.argv` 只带得到一个测试文件（多目标时既不是第一个也不是最后一个），无法判断本次
// 运行是否只跑该包；一旦误判，`mock.module('node:os')` 会不可撤销地把沙箱 HOME 泄漏给
// 同进程的其它包（gateway 的文件浏览 / 隧道用例依赖真实主目录）。
// 沙箱只由 packages/app/bunfig.toml 提供：`bun run test`（--filter，逐包以包目录为 cwd）与
// scripts/ci/unit-tests.ts（spawnSync 时 cwd = 包目录）都会命中它。
