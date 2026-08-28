import { existsSync } from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

function resolveBunExecutable(): string {
  const explicit = process.env.TMEX_E2E_BUN;
  if (explicit) return explicit;

  const home = process.env.HOME;
  if (home) {
    const candidate = join(home, '.bun', 'bin', 'bun');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'bun';
}

// 默认端口刻意避开生产常驻 tmex 的 9883，降低 e2e 误打生产实例的风险；
// 实际运行由 bun run test:e2e（scripts/run-e2e.ts）自动选空闲端口并注入 TMEX_E2E_*_PORT。
const DEFAULT_GATEWAY_PORT = 9665;
const DEFAULT_FE_PORT = 9885;

const gatewayPort = Number(process.env.TMEX_E2E_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
const fePort = Number(process.env.TMEX_E2E_FE_PORT) || DEFAULT_FE_PORT;

// mesh 用例自带一套 hub + node（tests/helpers/mesh-boot.ts 从源码起两个 runtime，
// 前端由 hub 直接托管 apps/fe/dist），与这里的 standalone gateway/vite 无关。
// 两个开关由 scripts/run-e2e.ts 按 --project / --grep 推导后注入：
//   TMEX_E2E_MESH=1       注册 mesh-setup / mesh / mesh-teardown 三个 project；
//   TMEX_E2E_MESH_ONLY=1  本轮只跑 mesh，跳过 standalone 的 webServer 与 globalSetup。
const meshEnabled = process.env.TMEX_E2E_MESH === '1';
const meshOnly = process.env.TMEX_E2E_MESH_ONLY === '1';
const MESH_TEST_FILES = /mesh[-.].*\.(spec|setup|teardown)\.ts$/;
const bunExecutable = resolveBunExecutable();
const forceFreshServers = Boolean(
  process.env.TMEX_E2E_DATABASE_URL || process.env.TMEX_E2E_SSH_DEVICE_NAME
);
const reuseExistingServer = !process.env.CI && !forceFreshServers;

// 用 connect 探测而非 listen：listen 不带 host 绑 ::，对监听 IPv4 的进程（如生产 tmex）会误判空闲
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

// 防护：无论 reuse 还是 fresh，只要端口未显式指定却已被占用，都拒绝运行——
// reuse 会命中未知实例（本机 9883 常驻生产 tmex）、fresh 也会与之冲突。要求显式指定
// env 或走 bun run test:e2e。globalSetup 另有一道 healthz=env:test 断言兜底。
if (!meshOnly) {
  const conflicts: string[] = [];
  if (!process.env.TMEX_E2E_GATEWAY_PORT && (await isPortListening(gatewayPort))) {
    conflicts.push(`gateway port ${gatewayPort} (TMEX_E2E_GATEWAY_PORT not set)`);
  }
  if (!process.env.TMEX_E2E_FE_PORT && (await isPortListening(fePort))) {
    conflicts.push(`fe port ${fePort} (TMEX_E2E_FE_PORT not set)`);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `[e2e] Refusing to use port(s) already occupied by unknown server(s): ${conflicts.join(
        ', '
      )}. This may be a production tmex instance. Set TMEX_E2E_FE_PORT / TMEX_E2E_GATEWAY_PORT explicitly (e.g. TMEX_E2E_FE_PORT=9885 TMEX_E2E_GATEWAY_PORT=9665), or run via \`bun run test:e2e\` which picks free ports automatically.`
    );
  }
}

export default defineConfig({
  testDir: './tests',
  // 兜底：跑任何用例前断言实际连到的 gateway 是 NODE_ENV=test 实例，绝不误改生产数据。
  globalSetup: './tests/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${fePort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: MESH_TEST_FILES,
      use: { ...devices['Desktop Chrome'] },
    },
    ...(meshEnabled
      ? [
          {
            name: 'mesh-setup',
            testMatch: /mesh\.setup\.ts$/,
            teardown: 'mesh-teardown',
          },
          {
            name: 'mesh-teardown',
            testMatch: /mesh\.teardown\.ts$/,
          },
          {
            name: 'mesh',
            testMatch: /mesh-.*\.spec\.ts$/,
            dependencies: ['mesh-setup'],
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
  webServer: meshOnly
    ? []
    : [
        {
          name: 'gateway',
          cwd: '../../',
          command: './apps/gateway/scripts/run-with-ssh-agent.sh ./apps/gateway/src/index.ts',
          // 行为配置（master key 等）由 gateway 自身 loadEnv() 从 test.env 加载；
          // 继承的安装版 TMEX_MIGRATIONS_DIR 由 loadEnv 净化、migrate.ts 回退到仓库 drizzle。
          // 这里只注入「按运行上下文变化的接线键」。
          env: {
            NODE_ENV: 'test',
            GATEWAY_PORT: String(gatewayPort),
            DATABASE_URL: process.env.TMEX_E2E_DATABASE_URL ?? `/tmp/tmex-e2e-${Date.now()}.db`,
            TMEX_BASE_URL: `http://localhost:${gatewayPort}`,
            // local 设备的 tmux 会话全部落到 e2e 专用 socket，与生产默认 socket 隔离；
            // 必须与 tests/helpers/tmux.ts 的 E2E_TMUX_SOCKET 一致。
            TMEX_TMUX_SOCKET: 'tmex-e2e',
          },
          url: `http://localhost:${gatewayPort}/healthz`,
          timeout: 60_000,
          reuseExistingServer,
          stdout: 'pipe',
          stderr: 'pipe',
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
        },
        {
          name: 'fe',
          cwd: '.',
          command: `${bunExecutable} run dev`,
          env: {
            ...process.env,
            // 注入 test：vite.config 的 loadTmexEnv 据此加载 test.env（省略 FE_PORT/
            // TMEX_GATEWAY_URL 等接线键，故下方动态注入值不会被覆盖）；同时覆盖掉
            // 继承自安装版 app.env 的 NODE_ENV=production（会污染 vite dev 依赖预打包）。
            NODE_ENV: 'test',
            FE_PORT: String(fePort),
            TMEX_GATEWAY_URL: `http://localhost:${gatewayPort}`,
          },
          url: `http://localhost:${fePort}`,
          timeout: 60_000,
          reuseExistingServer,
          stdout: 'pipe',
          stderr: 'pipe',
          gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
        },
      ],
});

export { DEFAULT_GATEWAY_PORT, DEFAULT_FE_PORT };
