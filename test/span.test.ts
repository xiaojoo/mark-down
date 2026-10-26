import { describe, expect, it } from 'vitest'
import { parse, splitEol, openChunked, chunkedRoot } from '../src/kernel/parse.ts'
import { serialize, span, type Node, type Span } from '../src/kernel/node.ts'
import { ROUNDTRIP, randomDocs } from './corpus.ts'

/*
 * 偏移映射的判据：**每个节点**都满足 text.slice(start, end) === serialize(node)。
 * 这一条成立，"点开任意子树、就地换掉它那段源码"才安全 —— 表格单元格、行内标记、
 * 引用块内的某一段，都靠它，不需要为每种元素再写一套定位。
 */
function check(s: Span, text: string, bad: string[]): void {
    if (text.slice(s.start, s.end) !== serialize(s.node))
        bad.push(`${s.node.type} [${s.start},${s.end}) 对不上 serialize`)
    let prev = s.start
    for (const k of s.kids) {
        if (k.start < prev || k.end > s.end) bad.push(`${s.node.type} 的孩子 ${k.node.type} 越界或乱序`)
        prev = k.end
        check(k, text, bad)
    }
}

function count(s: Span): number {
    return 1 + s.kids.reduce((a, k) => a + count(k), 0)
}

const docs = [...ROUNDTRIP.map(([, s]) => s), ...randomDocs(200, 4242)]

describe('源偏移落到任意子树', () => {
    let nodes = 0

    it.each(docs.map((d, i) => [i, d] as const))('文档 #%s', (_i, src) => {
        const text = splitEol(src).text
        const bad: string[] = []
        const root = span(parse(src).root, 0)
        nodes += count(root)
        check(root, text, bad)
        expect(bad).toEqual([])
    })

    it('遍历到的节点数足够多（否则上面全是空转）', () => {
        expect(nodes).toBeGreaterThan(1500)
    })

    /* 反证：动一个标记字节，同一个判据必须立刻不成立 */
    it('改掉一个字节的标记就不成立', () => {
        const src = '| a | b |\n| - | - |\n| 1 | 2 |\n'
        const root = span(parse(src).root, 0)
        const cell = (function find(n: Span): Span | undefined {
            if (n.node.type === 'tableCell') return n
            for (const k of n.kids) { const hit = find(k); if (hit) return hit }
            return undefined
        })(root)!
        const text = splitEol(src).text
        expect(text.slice(cell.start, cell.end)).toBe(serialize(cell.node))
        cell.node.open = '||'
        expect(text.slice(cell.start, cell.end)).not.toBe(serialize(cell.node))
    })

    /* 分块那条路也要给得出同样的偏移：界面用的是它 */
    it('分块树的偏移同样自洽', () => {
        for (const src of docs) {
            const c = openChunked(src)
            const bad: string[] = []
            check(span(chunkedRoot(c), 0), c.text, bad)
            expect(bad).toEqual([])
        }
    })
})

/* 渲染层要把区间发到 DOM 上，所以它拿到的起点必须和内核一致 */
function findType(n: Node, type: string): Node | undefined {
    if (n.type === type) return n
    for (const k of n.children) { const hit = findType(k, type); if (hit) return hit }
    return undefined
}

describe('内容区间（给就地编辑用）', () => {
    it('表格单元格的内容区间只盖住正文，不吃分隔管', () => {
        const src = '| 甲 | 乙 |\n| - | - |\n| 1 | 2 |\n'
        const root = span(parse(src).root, 0)
        const cell = (function f(s: Span): Span | undefined {
            if (s.node.type === 'tableCell') return s
            for (const k of s.kids) { const hit = f(k); if (hit) return hit }
            return undefined
        })(root)!
        const text = src
        const contentStart = cell.start + cell.node.open.length
        const contentEnd = cell.end - cell.node.close.length
        expect(text.slice(contentStart, contentEnd)).toBe('甲')
        expect(text.slice(cell.start, cell.end)).toContain('|')
        expect(findType(cell.node, 'text')?.type).toBe('text')
    })
})
