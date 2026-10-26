import { performance } from 'node:perf_hooks'
import { parse, serializeDoc, openChunked, editChunked, serializeChunked, chunkedRoot } from './src/kernel/parse.ts'
import { scanTop } from './src/kernel/split.ts'

const para = '一段普通的中文文字，带 **粗**、`码` 和一个 [链接](https://example.com/)。\n\n'
const quote = '> 引用两行\n> 第二行\n\n'
const list = '- 甲\n- 乙\n- 丙\n\n'
const fence = '```js\nlet a = 1\nconsole.log(a)\n```\n\n'
/* 一条脚注就够让扫描器放弃整篇分块，所以单独量它的代价 */
const note = '正文里有引用 [^a]\n\n[^a]: 脚注正文\n\n'

function build(qRatio, bytes, noteEvery = 0) {
    const parts = []
    let size = 0, i = 0
    while (size < bytes) {
        const chunk = noteEvery && i++ % noteEvery === 0 ? note
            : (i++ % 100) < qRatio * 100 ? quote
            : i % 7 === 0 ? list
            : i % 11 === 0 ? fence
            : para
        parts.push(chunk)
        size += Buffer.byteLength(chunk)
    }
    return parts.join('')
}

console.log('文档               整篇 ms   分块 ms   区域数   平均区域 KB   增量一次 ms   往返全等')
for (const [name, q, n, kb] of [['1 MB 无引用', 0, 0, 1000], ['1 MB 引用 5%', 0.05, 0, 1000],
    ['1 MB 引用 25%', 0.25, 0, 1000], ['1 MB 引用 100%', 1, 0, 1000],
    ['1 MB 每 200 块一条脚注', 0, 200, 1000], ['1 MB 每 20 块一条脚注', 0, 20, 1000],
    /* 脚注悬崖在真实笔记尺寸上有多大？正常一篇笔记就几十 KB */
    ['50 KB 含脚注', 0, 20, 50], ['200 KB 含脚注', 0, 20, 200], ['50 KB 无脚注', 0, 0, 50]]) {
    const src = build(q, kb * 1024, n)

    /* 只有"分块确实切开了"才值得再花一遍整篇解析（100% 引用那档整篇要 115 秒） */
    const splittable = scanTop(src).bounds.length > 1
    let wholeMs = NaN
    let wholeOk = null
    if (splittable) {
        const a = performance.now()
        const doc = parse(src)
        wholeMs = performance.now() - a
        wholeOk = serializeDoc(doc) === src
    }

    let t = performance.now(); const c = openChunked(src); const chunkMs = performance.now() - t
    const chunkOk = serializeChunked(c) === src

    /* 在最中间那块敲一个字：只该重算它所在的区域 */
    const mid = Math.floor(c.text.length / 2)
    t = performance.now(); const c2 = editChunked(c, mid, mid, 'x'); const editMs = performance.now() - t
    const editOk = serializeChunked(c2) === c.text.slice(0, mid) + 'x' + c.text.slice(mid)

    console.log(name.padEnd(22),
        (Number.isNaN(wholeMs) ? '跳过' : wholeMs.toFixed(0)).padStart(9),
        chunkMs.toFixed(0).padStart(9),
        String(c.regions.length).padStart(8),
        (c.text.length / c.regions.length / 1024).toFixed(1).padStart(12),
        editMs.toFixed(2).padStart(13),
        `${chunkOk && editOk}${Number.isNaN(wholeMs) ? '' : `/${wholeOk}`}`.padStart(14))
}
console.log('\n最后一列 = 分块与增量的往返全等（斜杠后是整篇那一路；"跳过"= 这篇没切块，整篇解析只是白跑）')
