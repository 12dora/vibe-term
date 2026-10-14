#!/usr/bin/env node
// 供只能指定「程序路径」的工具使用（scp -S、GIT_SSH、rsync -e）：等价于 `vibeterm rsh <args…>`。
process.argv.splice(2, 0, 'rsh');
await import('./vibeterm.js');
