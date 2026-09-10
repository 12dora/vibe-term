import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { visualizer } from 'rollup-plugin-visualizer';
import { type Plugin, type PluginOption, defineConfig, build as viteBuild } from 'vite';
import { buildPrecacheManifest } from './src/sw/precache-manifest';

// monorepo 版本真相源：发布的 vibeterm-cli（packages/app）版本。读取失败退回 0.0.0。
function readMonorepoVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../packages/app/package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// KaTeX 的 @font-face 按 woff2 → woff → ttf 三格式声明，本应用要求的浏览器都支持 woff2，
// 后两者只会白白进 dist 与 npm 包（~880 KB），这里在 CSS 阶段剔掉。
function katexWoff2Only(): Plugin {
  return {
    name: 'vibeterm-katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('katex') || !id.endsWith('.css')) return null;
      return {
        code: code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, ''),
        map: null,
      };
    },
  };
}

// 应用壳 Service Worker（src/sw/sw.ts）：把「一代构建」的 index.html + 全部哈希资源
// （外加三个默认字体，尽力而为）整体预缓存，iOS 主屏 PWA 的冷启动不再逐个走网络。
// 产物必须是根作用域下不带哈希的 dist/sw.js，因此不进主 bundle：等主构建落盘、拿到真实
// 资源清单之后，再跑一次独立的 lib 构建把它单独打出来。清单口径见 src/sw/precache-manifest.ts。
function serviceWorkerPlugin(version: string): Plugin {
  let root = __dirname;
  let outDir = path.resolve(__dirname, 'dist');
  let bundleNames: string[] | null = null;

  return {
    name: 'vibeterm-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      // worker 等子构建不产出 index.html，只有主构建才该触发 SW 打包
      if (!bundle['index.html']) return;
      bundleNames = Object.keys(bundle);
    },
    async closeBundle() {
      if (!bundleNames) return;
      const names = bundleNames;
      bundleNames = null;
      const precache = buildPrecacheManifest({
        html: readFileSync(path.join(outDir, 'index.html'), 'utf8'),
        bundleNames: names,
        css: readFileSync(path.resolve(__dirname, 'src/index.css'), 'utf8'),
      });
      const digest = createHash('sha256')
        .update(JSON.stringify(precache))
        .digest('hex')
        .slice(0, 12);
      const buildId = `${version}-${digest}`;
      await viteBuild({
        configFile: false,
        root,
        logLevel: 'warn',
        define: {
          __SW_BUILD_ID__: JSON.stringify(buildId),
          __SW_PRECACHE__: JSON.stringify(precache),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          target: 'es2020',
          minify: 'esbuild',
          lib: {
            entry: path.resolve(__dirname, 'src/sw/sw.ts'),
            formats: ['iife'],
            name: 'vibetermServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });
      console.log(
        `[vite] service worker: dist/sw.js build=${buildId} precache core=${precache.core.length} ` +
          `lazy=${precache.lazy.length} fonts=${precache.fonts.length}`
      );
    },
  };
}

// 与业务代码分开缓存的运行时框架：这几个包每次发版都不变，业务改动不该把它们一起作废。
// 刻意只列这几个，不做「node_modules 一刀切」——那会把懒加载边界（base-ui 弹层、hljs、
// 直连栈、sonner）全部拽回首屏。
const VENDOR_REACT_PACKAGES = new Set([
  'react',
  'react-dom',
  'scheduler',
  'react-router',
  '@tanstack/react-query',
  'i18next',
  'react-i18next',
  'zustand',
]);

/** 取模块 id 里最后一段 node_modules 后的包名（bun 的 `.bun/<pkg>@<ver>/node_modules/<pkg>` 布局也吃得下）。 */
export function packageNameOfModuleId(id: string): string | null {
  const marker = 'node_modules/';
  const at = id.lastIndexOf(marker);
  if (at < 0) return null;
  const [scopeOrName = '', nested = ''] = id.slice(at + marker.length).split('/');
  if (!scopeOrName) return null;
  return scopeOrName.startsWith('@') ? `${scopeOrName}/${nested}` : scopeOrName;
}

export function vendorChunkOf(id: string): string | undefined {
  const name = packageNameOfModuleId(id);
  return name && VENDOR_REACT_PACKAGES.has(name) ? 'vendor-react' : undefined;
}

export default defineConfig(({ mode }) => {
  // 前端只需要两个非密钥的接线值：网关地址与前端端口。
  // 这两者由 launcher 经 process.env 提供（dev-supervisor source development.env；
  // e2e 由 playwright 注入）。刻意不在这里加载后端 env 文件——否则会把
  // VIBETERM_MASTER_KEY 等后端密钥拉进 vite 进程，存在被打进前端 bundle 的风险。
  const gatewayUrl = process.env.VIBETERM_GATEWAY_URL || 'http://localhost:9663';
  const fePort = Number(process.env.FE_PORT) || 9883;
  const gatewayWsUrl = gatewayUrl.replace('http://', 'ws://').replace('https://', 'wss://');
  const monorepoVersion = readMonorepoVersion();
  const isProd = mode === 'production';

  console.log(`[vite] Gateway URL: ${gatewayUrl}`);
  console.log(`[vite] Frontend port: ${fePort}`);
  console.log(`[vite] Monorepo version: ${monorepoVersion} (prod=${isProd})`);

  // ANALYZE=1 时生成 dist/stats.html treemap（含 gzip/brotli 体积），用于量化包体积优化。
  const analyzePlugins: PluginOption[] = process.env.ANALYZE
    ? [
        visualizer({
          filename: 'dist/stats.html',
          gzipSize: true,
          brotliSize: true,
          template: 'treemap',
        }) as PluginOption,
      ]
    : [];

  return {
    plugins: [
      katexWoff2Only(),
      tailwindcss(),
      react(),
      serviceWorkerPlugin(monorepoVersion),
      ...analyzePlugins,
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: fePort,
      host: '0.0.0.0',
      allowedHosts: true,
      proxy: {
        '/api': {
          target: gatewayUrl,
          changeOrigin: true,
        },
        '/ws': {
          target: gatewayWsUrl,
          ws: true,
        },
      },
    },
    preview: {
      port: fePort,
      host: '0.0.0.0',
    },
    // 代码查看器的高亮 worker 用动态 import 按需拉 highlight.js 语言模块。worker 必须走 ES 格式
    // 才允许代码分割——默认的 iife 直接拒绝分割，会把 36 个语言全内联进 worker，等于没做按需。
    worker: { format: 'es' },
    build: {
      outDir: 'dist',
      // 生产构建默认不出 source map：~18MB 的 .map 会进 resources/fe-dist 随包分发，纯属负担
      // （浏览器正常不下载，但撑大安装/升级体积）。需要线上排障时 BUILD_SOURCEMAP=1 显式开启；dev 构建保留。
      sourcemap: process.env.BUILD_SOURCEMAP === '1' || !isProd,
      rollupOptions: {
        output: {
          manualChunks: (id) => vendorChunkOf(id),
        },
      },
    },
    define: {
      // 将关键配置暴露给前端代码
      __GATEWAY_URL__: JSON.stringify(gatewayUrl),
      __MONOREPO_VERSION__: JSON.stringify(monorepoVersion),
      __IS_PROD__: JSON.stringify(isProd),
    },
  };
});
