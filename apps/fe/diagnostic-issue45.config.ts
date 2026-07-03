import { defineConfig, devices } from '@playwright/test';

// Task 6 鼠标坐标诊断专用 config（不进 CI）：连 worktree dev 实例（gateway 19663 +
// vite 19883），不引入 global-setup（dev gateway env='development' 会被默认 globalSetup
// 拒），不启动自有 webServer。前提：dev supervisor 已启动、TMUX_TMUX_SOCKET=tmex-e2e
// 已通过 development.env.local 注入。
// 跑法：在 worktree 根执行 bunx playwright test --config apps/fe/diagnostic-issue45.config.ts

const GATEWAY_PORT = 19663;
const FE_PORT = 19883;
void GATEWAY_PORT;

export default defineConfig({
  testDir: './tests',
  testMatch: 'issue45-mouse-coordinate-diagnostic.spec.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${FE_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
  },
});
