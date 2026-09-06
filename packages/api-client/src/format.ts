// 传输 UI 用的字节/速率格式化。实现在 `@vibeterm/shared`，此处只做转发，
// 免得同一套换算在包里各写一份。

export { formatBytes, formatBytesPair, formatEta, formatRate } from '@vibeterm/shared';
