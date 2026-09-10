// 页面 ↔ SW 的消息协议常量。单独成模块：sw.ts 与页面侧的逃生通道（sw-reload.ts）必须
// 用同一个字面量，写歪了不会报错、只会让逃生通道静默失效。
// packages/ui/src/lazy-overlay.tsx 因为不能依赖 apps/fe，另抄了一份同名常量（有交叉注释）。

export const SW_SKIP_WAITING_MESSAGE = 'vibeterm:sw-skip-waiting';
