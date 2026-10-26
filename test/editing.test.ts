import { describe, expect, it } from 'vitest'
import { enterAction, insertBlockAt } from '../src/app/editing.ts'
import { openChunked, blocks, serializeChunked, editChunked } from '../src/kernel/parse.ts'

describe('回车判据', () => {
    it('光标不在文末一律是换行', () => {
        expect(enterAction('甲\n乙\n', 1)).toBe('newline')
        expect(enterAction('甲\n乙\n', 3)).toBe('newline')
    })

    it('文末且上一行是空行 → 另起一块', () => {
        expect(enterAction('甲\n乙\n', 4)).toBe('split')     /* 已经换了一次行 */
        expect(enterAction('\n', 1)).toBe('split')
    })

    it('文末但上一行还有字 → 只是换行', () => {
        expect(enterAction('甲\n乙', 3)).toBe('newline')
        expect(enterAction('', 0)).toBe('newline')
    })
})

describe('插入新块时补齐分隔', () => {
    /* at 落在三种位置，各补不同的换行，补错就会把新块并进上一段 */
    const cases: [string, string, number, string][] = [
        ['两块之间（at 在下一块起点）', '甲\n\n乙\n', 3, '甲\n\n新\n\n乙\n'],
        ['at 正好在块末尾（前面缺空行）', '甲\n乙\n', 3, '甲\n乙\n\n新\n'],
        ['at 在块后的那个换行上', '甲\n乙\n', 4, '甲\n乙\n\n新\n'],
        ['at 已在空行之后（原有的多空行不归我管）', '甲\n\n\n乙\n', 4, '甲\n\n\n新\n\n乙\n'],
        ['文档为空', '', 0, '新\n'],
    ]
    for (const [name, doc, at, want] of cases) {
        it(name, () => {
            const s = insertBlockAt(doc, at, '新')
            expect(doc.slice(0, s.from) + s.ins + doc.slice(s.to)).toBe(want)
        })
    }

    it('插入后新块真的是独立的一块（不是并进上一段）', () => {
        const doc = '甲\n\n乙\n'
        const s = insertBlockAt(doc, 3, '新')
        const next = doc.slice(0, s.from) + s.ins + doc.slice(s.to)
        const c = openChunked(next)
        /* 块区间不含尾随换行（那道换行归父节点的 close） */
        expect(blocks(c).map(b => c.text.slice(b.start, b.end))).toEqual(['甲', '新', '乙'])
        expect(serializeChunked(c)).toBe(next)
    })

    it('尾部多余换行会被收掉，不累积空行', () => {
        const doc = '甲\n\n乙\n'
        const s = insertBlockAt(doc, 3, '新\n\n\n')
        expect(s.ins).toBe('新\n\n')
    })

    /* 反证：分隔补错位的症状就是"两块变一块"，这条断言必须能抓到 */
    it('少补一个换行就会被识别成同一块', () => {
        const right = openChunked('甲\n\n新\n\n乙\n')
        const wrong = openChunked('甲\n新\n乙\n')
        expect(blocks(right).length).toBe(3)
        expect(blocks(wrong).length).toBe(1)
    })
})

/* 走一遍真内核：两次回车的净效果 = 多出一块，且逐字节仍可往返 */
describe('两次回车的净效果', () => {
    it('在最后一块末尾连敲两次回车', () => {
        const src = '第一段\n\n第二段\n'
        let c = openChunked(src)
        const bs = blocks(c)
        const last = bs[bs.length - 1]
        /* 第一次回车：textarea 里多一个换行，块内容不变 */
        const afterFirst = '第二段\n'
        expect(enterAction(afterFirst, afterFirst.length)).toBe('split')
        /* 第二次回车：把这一块收成"第二段"，然后在它后面开插入点 */
        c = editChunked(c, last.start, last.end, '第二段')
        const s = insertBlockAt(c.text, last.end, '新写的')
        c = editChunked(c, s.from, s.to, s.ins)
        expect(serializeChunked(c)).toBe(c.text)
        expect(c.text).toBe('第一段\n\n第二段\n\n新写的\n')
        expect(blocks(c).map(b => c.text.slice(b.start, b.end))).toEqual(['第一段', '第二段', '新写的'])
    })
})
