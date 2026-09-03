/** canonical PaneData 批量下发的节流常量（原 TerminalOutputBatcher 的一部分，legacy 下线后只剩 canonical 使用）。 */
export const GATEWAY_TERM_OUTPUT_BATCH_DELAY_MS = 16;
export const GATEWAY_TERM_OUTPUT_BATCH_MAX_BYTES = 64 * 1024;
export const GATEWAY_TERM_OUTPUT_COOLDOWN_MAX_KEYS = 4096;
