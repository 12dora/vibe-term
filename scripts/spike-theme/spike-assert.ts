#!/usr/bin/env bun
/**
 * 宿主侧断言：解读 spike-logs/<tag>/<test-id>/ 采集结果，输出行为矩阵。
 * 解码 %output 直接复用生产的 unescapeControlModeData（顺带验证生产解码路径）。
 * 用法: bun scripts/spike-theme/spike-assert.ts <spike-logs 根目录>
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unescapeControlModeData } from '../../apps/gateway/src/tmux-client/control-mode-parser'

const root = process.argv[2]
if (!root) {
  console.error('用法: bun spike-assert.ts <spike-logs 根目录>')
  process.exit(1)
}

const HEX = {
  csi2031h: '1b5b3f3230333168',
  csi2031l: '1b5b3f323033316c',
  csi1004h: '1b5b3f3130303468',
  csi1004l: '1b5b3f313030346c',
  multi: '1b5b3f313030343b3230333168',
  csi2004h: '1b5b3f3230303468',
  csi1049h: '1b5b3f3130343968',
  q10: '1b5d31303b3f',
  q11: '1b5d31313b3f',
  q996: '1b5b3f3939366e',
  resp997dark: '1b5b3f3939373b316e',
  resp997light: '1b5b3f3939373b326e',
  osc10resp: '1b5d31303b726762',
  osc11resp: '1b5d31313b726762',
  focusOut: '1b5b4f',
  focusIn: '1b5b49',
  decrpm2031: '1b5b3f323033313b',
  decrpm1004: '1b5b3f313030343b',
  passthroughRaw: '1b50746d75783b',
}

function decodeCmLog(path: string): { allHex: string; lines: string[]; hasPause: boolean } {
  if (!existsSync(path)) return { allHex: '', lines: [], hasPause: false }
  const raw = readFileSync(path, 'latin1')
  const lines = raw.split('\n')
  let bytes: number[] = []
  let hasPause = false
  for (const line of lines) {
    if (line.startsWith('%pause')) hasPause = true
    let data: string | null = null
    if (line.startsWith('%output ')) {
      const rest = line.slice('%output '.length)
      const sp = rest.indexOf(' ')
      if (sp >= 0) data = rest.slice(sp + 1)
    } else if (line.startsWith('%extended-output ')) {
      hasPause = true
      const sep = line.indexOf(' : ')
      if (sep >= 0) data = line.slice(sep + 3)
    }
    if (data === null) continue
    const decoded = unescapeControlModeData(Buffer.from(data, 'latin1'), 0)
    bytes.push(...decoded)
  }
  return { allHex: Buffer.from(bytes).toString('hex'), lines, hasPause }
}

function tuiLogHex(path: string): { recvHex: string; recvChunks: string[] } {
  if (!existsSync(path)) return { recvHex: '', recvChunks: [] }
  const chunks: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\d+ ([0-9a-f]+)$/)
    if (m) chunks.push(m[1])
  }
  return { recvHex: chunks.join(''), recvChunks: chunks }
}

function count(haystack: string, needle: string): number {
  let n = 0
  let i = 0
  while ((i = haystack.indexOf(needle, i)) >= 0) {
    n++
    i += needle.length
  }
  return n
}

function readIf(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
}

interface Row {
  tag: string
  test: string
  result: string
  detail: string
}
const rows: Row[] = []

for (const tag of readdirSync(root).sort()) {
  const tagDir = join(root, tag)
  if (!statSync(tagDir).isDirectory()) continue
  const ver = readIf(join(tagDir, 'tmux-version.txt')) || '?'

  for (const test of readdirSync(tagDir).sort()) {
    const dir = join(tagDir, test)
    if (!statSync(dir).isDirectory()) continue
    const cm = decodeCmLog(join(dir, 'cm.log'))
    const tui = tuiLogHex(join(dir, 'tui.log'))
    let result = ''
    let detail = ''

    if (test.startsWith('T1_')) {
      const key = test.slice(3)
      const target =
        key === '2031h' ? HEX.csi2031h
        : key === '2031l' ? HEX.csi2031l
        : key === '1004h' ? HEX.csi1004h
        : key === '1004l' ? HEX.csi1004l
        : key === 'multi' ? HEX.multi
        : key === '2004h' ? HEX.csi2004h
        : HEX.csi1049h
      result = cm.allHex.includes(target) ? 'VISIBLE' : 'SWALLOWED'
    } else if (test.startsWith('T2_')) {
      const q = test.includes('q10') ? HEX.q10 : test.includes('q11') ? HEX.q11 : HEX.q996
      const passedThrough = cm.allHex.includes(q)
      const respNeedle = test.includes('q996')
        ? HEX.resp997dark.slice(0, -2)
        : test.includes('q10') ? HEX.osc10resp : HEX.osc11resp
      const answered = tui.recvHex.includes(respNeedle)
      result = `passthru=${passedThrough ? 'Y' : 'N'} answered=${answered ? 'Y' : 'N'}`
      if (answered) detail = `resp=${tui.recvChunks.find((c) => c.includes(respNeedle)) ?? ''}`
    } else if (test.startsWith('T3_')) {
      const target = test.includes('light') ? HEX.resp997light : HEX.resp997dark
      result = tui.recvHex.includes(target) ? 'INTACT' : `BROKEN got=${tui.recvHex}`
    } else if (test.startsWith('T4_')) {
      const n = count(tui.recvHex, HEX.osc11resp)
      result = n === 1 ? 'INTACT x1' : `count=${n} got=${tui.recvHex}`
    } else if (test.startsWith('T5_')) {
      const gotO = tui.recvHex.includes(HEX.focusOut)
      const gotI = tui.recvHex.includes(HEX.focusIn)
      const extraI = count(tui.recvHex, HEX.focusIn)
      result = `O=${gotO ? 'Y' : 'N'} I=${gotI ? 'Y' : 'N'} I-count=${extraI}`
    } else if (test.startsWith('T6_')) {
      const before = readIf(join(dir, 'before.txt'))
      const after = readIf(join(dir, 'after.txt'))
      const afterEnter = readIf(join(dir, 'after-enter.txt'))
      const polluted = before !== after
      result = polluted ? 'POLLUTED' : 'CLEAN'
      if (polluted) {
        const diffLines = after.split('\n').filter((l) => !before.includes(l) && l.trim())
        detail = `after=${JSON.stringify(diffLines.slice(0, 2))}`
      }
      const enterDiff = afterEnter.split('\n').filter((l) => !after.includes(l) && l.trim())
      if (enterDiff.length) detail += ` afterEnter=${JSON.stringify(enterDiff.slice(0, 2))}`
    } else if (test === 'T7_sub') {
      const got997 = tui.recvHex.includes(HEX.resp997dark.slice(0, 12))
      const dark = count(tui.recvHex, HEX.resp997dark)
      const light = count(tui.recvHex, HEX.resp997light)
      result = `any997=${got997 ? 'Y' : 'N'} dark×${dark} light×${light}`
      detail = `show_theme=${JSON.stringify(readIf(join(dir, 'cmd-show_theme.txt')))} set_dark=${JSON.stringify(readIf(join(dir, 'cmd-set_theme_dark.txt')))} fmt=${JSON.stringify(readIf(join(dir, 'cmd-fmt.txt')))}`
    } else if (test.startsWith('T8_')) {
      const needle = test.includes('1004') ? HEX.decrpm1004 : HEX.decrpm2031
      const idx = tui.recvHex.indexOf(needle)
      if (idx >= 0) {
        result = 'ANSWERED'
        detail = `resp=${tui.recvHex.slice(idx, idx + 24)}`
      } else {
        result = `NO-ANSWER passthru=${cm.allHex.includes(test.includes('1004') ? '1b5b3f313030342470' : '1b5b3f323033312470') ? 'Y' : 'N'}`
      }
    } else if (test === 'T9') {
      detail = `set=${JSON.stringify(readIf(join(dir, 'cmd-set.txt')))} show=${JSON.stringify(readIf(join(dir, 'cmd-show.txt')))} list=${JSON.stringify(readIf(join(dir, 'cmd-list.txt')))} after=${JSON.stringify(readIf(join(dir, 'cmd-list_after.txt')))}`
      result = readIf(join(dir, 'cmd-show.txt')).includes('on') ? 'WORKS' : 'CHECK'
    } else if (test === 'T10') {
      const markerSeen = cm.allHex.includes(HEX.csi2031h)
      result = `pause=${cm.hasPause ? 'Y' : 'N'} markerAfter=${markerSeen ? 'KEPT' : 'LOST'}`
    } else if (test.startsWith('T11_')) {
      const raw = cm.allHex.includes(HEX.passthroughRaw)
      const unwrapped = cm.allHex.includes(HEX.csi2031h)
      result = `dcsRaw=${raw ? 'Y' : 'N'} unwrapped2031h=${unwrapped ? 'Y' : 'N'}`
    } else {
      continue
    }
    rows.push({ tag: `${tag}(${ver.replace('tmux ', '')})`, test, result, detail })
  }
}

const tests = [...new Set(rows.map((r) => r.test))].sort()
const tags = [...new Set(rows.map((r) => r.tag))].sort()
console.log('| 测试项 | ' + tags.join(' | ') + ' |')
console.log('|---|' + tags.map(() => '---').join('|') + '|')
for (const t of tests) {
  const cells = tags.map((g) => rows.find((r) => r.tag === g && r.test === t)?.result ?? '-')
  console.log(`| ${t} | ${cells.join(' | ')} |`)
}
console.log('\n=== 详情（非空 detail）===')
for (const r of rows.filter((r) => r.detail)) {
  console.log(`[${r.tag}] ${r.test}: ${r.result}\n    ${r.detail}`)
}
