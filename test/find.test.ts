import { describe, expect, it } from 'vitest'
import { findMatches, replaceOne, replaceAll, hitsIn, blockOf, caseSensitive } from '../src/app/find.ts'
import { openChunked, blocks, serializeChunked, editChunked } from '../src/kernel/parse.ts'
import { renderBlocks } from '../src/render/html.ts'
import { ROUNDTRIP } from './corpus.ts'

describe('命中区间', () => {
    it('命中的就是那几个字节，且互不重叠、按序', () => {
        const src = '粗 粗 粗\n'
        const hits = findMatches(src, '粗')
        expect(hits).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }])
        for (const h of hits) expect(src.slice(h.start, h.end)).toBe('粗')
    })

    it('空查询不匹配任何东西（不许把每个位置都算命中）', () => {
        expect(findMatches('abc', '')).toEqual([])
    })

    it('大小写规则：查询里有大写才区分', () => {
        expect(caseSensitive('foo')).toBe(false)
        expect(caseSensitive('Foo')).toBe(true)
        expect(findMatches('Foo foo FOO', 'foo').length).toBe(3)
        expect(findMatches('Foo foo FOO', 'Foo').length).toBe(1)
        expect(findMatches('Foo foo FOO', 'FOO').length).toBe(1)
    })

    it('相邻不重叠：aa 在 aaaa 里只中两次', () => {
        expect(findMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }])
    })

    it('能搜进标记内部（源码视角）', () => {
        const src = '这是**粗**字\n'
        const hits = findMatches(src, '粗')
        expect(hits.length).toBe(1)
        expect(src.slice(hits[0].start, hits[0].end)).toBe('粗')
    })
})

describe('替换', () => {
    it('替换第 n 个，其余不动', () => {
        const r = replaceOne('粗 粗 粗\n', '粗', 'X', 1)
        expect(r.text).toBe('粗 X 粗\n')
        expect(r.changed).toBe(true)
        expect(replaceOne('a\n', 'z', 'X', 0).changed).toBe(false)
    })

    it('全部替换的次数等于命中数，且从后往前换不位移', () => {
        const src = 'a a a\n'
        const r = replaceAll(src, 'a', 'bb')
        expect(r.count).toBe(findMatches(src, 'a').length)
        expect(r.text).toBe('bb bb bb\n')
    })

    it('替换完仍逐字节可往返（走的是内核的 editChunked）', () => {
        const src = '# 标题\n\n段落 **粗** 与 粗\n\n> 引用里的粗\n'
        let c = openChunked(src)
        for (const h of findMatches(c.text, '粗').reverse())
            c = editChunked(c, h.start, h.end, '黑')
        expect(serializeChunked(c)).toBe(c.text)
        expect(c.text).toBe('# 标题\n\n段落 **黑** 与 黑\n\n> 引用里的黑\n')
    })
})

describe('高亮映射', () => {
    it('hitsIn 只收完整落在区间里的命中', () => {
        const hits = findMatches('abcabc', 'abc')
        expect(hitsIn(hits, 0, 3)).toEqual([{ start: 0, end: 3 }])
        expect(hitsIn(hits, 1, 6)).toEqual([{ start: 3, end: 6 }])
    })

    it('blockOf 能把命中归到正确的块', () => {
        const src = '# 标题\n\n第二段 粗\n'
        const c = openChunked(src)
        const bs = blocks(c)
        const h = findMatches(c.text, '粗')[0]
        expect(blockOf(bs, h)).toBe(1)
        expect(blockOf(bs, { start: 0, end: 1 })).toBe(0)
    })

    it('命中画成 <mark>，当前那个另加一档', () => {
        const src = '段落 粗 与 粗\n'
        const c = openChunked(src)
        const hits = findMatches(c.text, '粗')
        const out = renderBlocks(blocks(c), { text: c.text, marks: hits, current: 1 })
        expect((out.match(/<mark class="md-hit/g) ?? []).length).toBe(2)
        expect(out).toContain('<mark class="md-hit">粗</mark>')
        expect(out).toContain('<mark class="md-hit md-hit-current">粗</mark>')
        expect(out).toContain('md-hit-block')
    })

    it('不搜的时候一个 mark 都不画', () => {
        const c = openChunked('段落 粗\n')
        expect(renderBlocks(blocks(c), { text: c.text })).not.toContain('<mark')
    })

    it('命中被转义，不许借高亮逃出文本', () => {
        const src = 'a<script>b\n'
        const c = openChunked(src)
        const out = renderBlocks(blocks(c), {
            text: c.text, marks: findMatches(c.text, '<script>'), current: 0,
        })
        expect(out).not.toContain('<script')
        expect(out).toContain('&lt;script&gt;')
    })

    /* 引用块续行上的 `> ` 被显示层擦掉了，命中照样要画对 */
    it('引用块续行里的命中也画得出来', () => {
        const src = '> 第一行 源码\n> 第二行 目标\n'
        const c = openChunked(src)
        const hits = findMatches(c.text, '目标')
        expect(hits.length).toBe(1)
        const out = renderBlocks(blocks(c), { text: c.text, marks: hits, current: 0 })
        expect(out).toContain('<mark class="md-hit md-hit-current">目标</mark>')
        /* 擦掉的 `> ` 不许混进高亮串 */
        expect(out).not.toContain('<mark class="md-hit md-hit-current">&gt; ')
    })

    it('跨行的命中只画落在同一叶子内的那一段', () => {
        const src = '> 甲 乙\n> 丙 丁\n'
        const c = openChunked(src)
        const out = renderBlocks(blocks(c), { text: c.text, marks: [{ start: 4, end: 9 }], current: 0 })
        expect(out).toContain('<mark')
        expect(serializeChunked(c)).toBe(src)
    })

    /* 块叶子（代码块 / html 块 / frontmatter / 引用定义）是逐字符原样显示的，也要能画 */
    it('代码块与定义块里的命中同样画得出高亮', () => {
        const src = '```js\nlet serialize = 1\n```\n\n[ty]: https://typora.io\n'
        const c = openChunked(src)
        const out = renderBlocks(blocks(c), { text: c.text, marks: findMatches(c.text, 'serialize'), current: 0 })
        expect(out).toContain('<mark class="md-hit md-hit-current">serialize</mark>')
        const out2 = renderBlocks(blocks(c), { text: c.text, marks: findMatches(c.text, 'typora'), current: 0 })
        expect(out2).toContain('<mark class="md-hit md-hit-current">typora</mark>')
        expect(out2).not.toContain('<mark class="md-hit md-hit-current">typora.io')
    })

    it('行内代码里也能画', () => {
        const c = openChunked('用 `serialize(x)` 包一下\n')
        const out = renderBlocks(blocks(c), { text: c.text, marks: findMatches(c.text, 'serialize'), current: 0 })
        expect(out).toContain('<mark class="md-hit md-hit-current">serialize</mark>')
    })

    /* 反证：判据要能红。把命中区间挪开一位，mark 里的字就该跟着变 */
    it('区间错一位，高亮的字就错一位', () => {
        const c = openChunked('粗 与 细\n')
        const hit = findMatches(c.text, '细')[0]
        const right = renderBlocks(blocks(c), { text: c.text, marks: [hit], current: 0 })
        const wrong = renderBlocks(blocks(c), { text: c.text, marks: [{ start: hit.start - 2, end: hit.end - 2 }], current: 0 })
        expect(right).toContain('>细</mark>')
        expect(wrong).toContain('>与</mark>')
    })
})

/* 全语料扫一遍：任何一条上"命中数 = 逐个替换后的差值"都得成立 */
describe('在整份语料上成立', () => {
    it.each(ROUNDTRIP.map(([, s], i) => [i, s] as const))('文档 #%s', (_i, src) => {
        const c = openChunked(src)
        const q = 'a'
        const hits = findMatches(c.text, q)
        const r = replaceAll(c.text, q, 'aa')
        expect(r.count).toBe(hits.length)
        expect(findMatches(r.text, 'aa').length).toBeGreaterThanOrEqual(hits.length)
        expect(serializeChunked(openChunked(r.text))).toBe(r.text)
    })
})
