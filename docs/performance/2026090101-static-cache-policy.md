# 打包前端静态资源缓存策略

iOS PWA 冷启动时 Safari 会反复校验/重下 `public/fonts`（约 2.48 MB）与未带哈希的静态文件。`packages/app` 运行时 `serve-frontend.ts` 是唯一的 `fe-dist` 静态处理器（gateway 不直接 serve SPA）。

- Vite 默认 `assets/[name]-[hash].ext`（`vite.config.ts` 未覆盖 `rollupOptions.output`）：`Cache-Control: public, max-age=31536000, immutable`。
- 其余文件（`index.html`、图标、`/fonts/*.woff2` 等）：`Cache-Control: no-cache`，附 `ETag`（`W/"<size>-<mtimeMs>"`）与 `Last-Modified`，命中 `If-None-Match` / `If-Modified-Since` 返回 304。
- 不协商 `Accept-Encoding`，故不下发 `Vary`。`/manifest` 仍由 gateway `manifestJson` 设为 `no-store`，本策略不改。
