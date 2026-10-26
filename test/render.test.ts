import { describe, expect, it } from 'vitest'
import { openChunked, blocks, serializeChunked, chunkedRoot, editChunked } from '../src/kernel/parse.ts'
import { renderBlocks, decomposeCode, displayText, esc, cellSource, checkRanges } from '../src/render/html.ts'
import type { Node, Span } from '../src/kernel/node.ts'
import { span } from '../src/kernel/node.ts'
import { ROUNDTRIP } from './corpus.ts'

function countNodes(n: Node): number {
    return 1 + n.children.reduce((a, c) => a + countNodes(c), 0)
}

function firstSpan(s: Span, type: string): Span | undefined {
    if (s.node.type === type) return s
    for (const k of s.kids) { const hit = firstSpan(k, type); if (hit) return hit }
    return undefined
}

const render = (src: string, editing?: number) => {
    const c = openChunked(src)
    return renderBlocks(blocks(c), { text: c.text, editing })
}

describe('标记落在 md-meta，正文落在 md-text', () => {
    it('粗体的两侧星号各是一个 meta span', () => {
        const out = render('**粗**\n')
        expect(out).toContain('<span class="md-meta">**</span>')
        expect(out).toMatch(/class="md-text"[^>]*>粗</)
        expect(out).toContain('class="md-strong md-eu"')
        expect(out.match(/md-meta/g)?.length).toBe(2)
    })

    it('标题井号是 meta，正文干净', () => {
        const out = render('## 小标\n')
        expect(out).toContain('<span class="md-meta">## </span>')
        /* 级别类名在块外层（编辑态没有里面那层，字号得靠外层继承） */
        expect(out).toContain('md-heading-block md-h2"')
        expect(out).toContain('<div class="md-heading md-eu" ')
        expect(out).toMatch(/class="md-text"[^>]*>小标</)
    })

    it('setext 下划线留在 close 里', () => {
        const out = render('标题\n===\n')
        expect(out).toContain('<span class="md-meta">\n===</span>')
    })

    it('列表标记逐条可见', () => {
        const out = render('- 甲\n- 乙\n')
        expect(out.match(/<span class="md-meta">- <\/span>/g)?.length).toBe(2)
    })

    it('引用续行的 > 从正文里擦掉，但树没动', () => {
        const src = '> a\n> b\n'
        expect(displayText('a\n> b')).toBe('a\nb')
        expect(render(src)).toMatch(/class="md-text"[^>]*>a\nb</)
        const c = openChunked(src)
        expect(serializeChunked(c)).toBe(src)
    })

    it('围栏代码：lang 单独给，正文原样，围栏行是 meta', () => {
        const p = decomposeCode('```ts\nlet a = 1\n```')
        expect(p).toEqual({ open: '```ts\n', lang: 'ts', body: 'let a = 1', close: '\n```' })
        const out = render('```ts\nlet a = 1\n```\n')
        expect(out).toContain('data-lang="ts"')
        expect(out).toContain('<span class="md-meta md-fence">```ts\n</span>')
        expect(out).toContain('let a = 1')
    })

    it('未闭合围栏没有 close', () => {
        expect(decomposeCode('```\nx').close).toBe('')
        expect(decomposeCode('```\nx').body).toBe('x')
    })
})

describe('文档内容不许当成 HTML 注入', () => {
    it('原始标签一律转义', () => {
        const out = render('<script>alert(1)</script>\n')
        expect(out).not.toContain('<script')
        expect(out).toContain('&lt;script&gt;')
    })

    it('行内 HTML 与加粗标签也不放行', () => {
        const out = render('文字 <img src=x onerror=alert(1)> More\n')
        /* 转义后 "onerror=alert(1)" 这串本来就该还在（它是正文）；
         * 要查的是它没逃成一个真标签 */
        expect(out).not.toContain('<img')
        expect(out).not.toContain('onerror=alert(1)>')
        expect(out).toContain('&lt;img')
    })

    it('图片地址带 javascript: 就退回源码显示', () => {
        const out = render('![a](javascript:alert(1))\n')
        expect(out).not.toContain('<img')
    })

    it('普通图片才真的出 img', () => {
        const out = render('![猫](cat.png)\n')
        expect(out).toContain('<img class="md-img" src="cat.png" alt="猫">')
    })

    it('属性值里的引号被关掉', () => {
        expect(esc('a"b')).toBe('a&quot;b')
    })
})

describe('编辑态', () => {
    const src = '# 标题\n\n段落 **粗**\n'

    it('点中的块换成 textarea，内容是它自己的源码', () => {
        const out = render(src, 1)
        expect(out).toContain('class="md-block md-paragraph-block md-editing" data-i="1"')
        expect(out).toContain('段落 **粗**')
        expect(out).toContain('md-src')
    })

    it('没点中的块仍是渲染态', () => {
        const out = render(src, 1)
        expect(out).toContain('md-heading-block md-h1"')
        expect(out).not.toContain('<div class="md-text">')   /* 行内 text 不许被套成块 */
        expect(out.match(/<textarea/g)?.length).toBe(1)
    })

    it('textarea 里的源码转义过，正文不许逃出标签', () => {
        const out = render('a </textarea><b>x</b>\n', 0)
        expect(out).not.toContain('</textarea><b>')
    })
})

/*
 * 界面完全靠这些区间做事，所以"发出去的属性指得回那段源码"必须是一条常驻门禁：
 * 只测 Node 层不够，渲染器拼错一个属性名同样会让就地编辑把邻居吃掉。
 */
describe('发进 DOM 的区间可信', () => {
    const withMarks = [
        '| 甲 | 乙 |\n| - | - |\n| 1 | 2 |\n',
        '段落 **粗** 和 [链接](u) 与 ![图](a.png)\n',
        '> 引用两行\n> 第二行\n\n- 列表\n',
        '# 标题 ✨\n\n```\ncode\n```\n',
    ]

    for (const src of withMarks) {
        it(`data-* 全部对得上 ${JSON.stringify(src).slice(0, 24)}`, () => {
            const c = openChunked(src)
            const out = renderBlocks(blocks(c), { text: c.text })
            const hits = [...out.matchAll(/data-s="(\d+)" data-e="(\d+)" data-cs="(\d+)" data-ce="(\d+)"/g)]
                .map(m => [ +m[1], +m[2], +m[3], +m[4] ])
            expect(hits.length).toBeGreaterThan(2)
            /* 树里每个可寻址节点都该有一个元素带着它的区间；root 本身不渲染成元素 */
            expect(hits.length).toBe(countNodes(chunkedRoot(c)) - 1)
            expect(checkRanges(blocks(c), c.text)).toEqual([])
            for (const [s, e, cs, ce] of hits) {
                expect(cs).toBeGreaterThanOrEqual(s)
                expect(ce).toBeLessThanOrEqual(e)
                expect(e).toBeGreaterThan(s)
            }
            /* 区间家族必须"互不相交或互相包含"——正当嵌套不是交叉；
             * 出现既重叠又互不包含的两段，才说明定位真的错了 */
            const inside = (x: number[], y: number[]) => x[0] <= y[0] && y[1] <= x[1]
            for (const a of hits) for (const b of hits) {
                const intersects = a[0] < b[1] && b[0] < a[1]
                if (intersects && !inside(a, b) && !inside(b, a))
                    expect(`${JSON.stringify(a)} 与 ${JSON.stringify(b)} 既重叠又互不包含`).toBe('')
            }
        })
    }

    /* 单元格正文单独包一层 .md-body，它标的区间就是可以安全替换的那一段 */
    it('单元格的 .md-body 区间 = 内容区间，不含分隔管', () => {
        const src = '| 甲 | 乙 |\n| - | - |\n| 1 | 2 |\n'
        const c = openChunked(src)
        const out = renderBlocks(blocks(c), { text: c.text })
        const m = /class="md-tableCell" data-s="(\d+)" data-e="(\d+)" data-cs="(\d+)" data-ce="(\d+)"[^>]*>([\s\S]*?)<span class="md-body" data-b="(\d+),(\d+)"/
            .exec(out)!
        expect(c.text.slice(+m[3], +m[4])).toBe('甲')
        expect([+m[6], +m[7]]).toEqual([+m[3], +m[4]])
        expect(c.text.slice(+m[6], +m[7])).not.toContain('|')
        /* 开口的分隔管必须在 .md-body 之前，也就是光标进格子碰不到它 */
        expect(m[5]).toContain('<span class="md-meta">| </span>')
    })
})

describe('提示块', () => {
    it('> [!NOTE] 认出提示块并带上类名，标记仍留在源码里', () => {
        const out = render('> [!NOTE] 注意\n')
        expect(out).toContain('md-alert md-alert-note')
        expect(out).toContain('[!NOTE]')
        const c = openChunked('> [!NOTE] 注意\n')
        expect(serializeChunked(c)).toBe('> [!NOTE] 注意\n')
    })
    it('五种都认，普通引用不误认', () => {
        for (const k of ['note', 'tip', 'important', 'warning', 'caution'])
            expect(render(`> [!${k.toUpperCase()}] x\n`)).toContain(`md-alert-${k}`)
        expect(render('> 普通引用\n')).not.toContain('md-alert')
    })
})

/* 竖线必须转义、换行必须折掉，否则一次单元格编辑就把表格结构改坏 */
describe('单元格回写', () => {
    it('竖线转义、换行折成空格', () => {
        expect(cellSource('a|b')).toBe('a\\|b')
        expect(cellSource('a\nb')).toBe('a b')
        expect(cellSource('a\r\n|b')).toBe('a \\|b')
    })
    /* 就地编辑的正确做法是只替换单元格的**内容区间**，两侧分隔管与分隔行都不许动 */
    it('只换单元格内容区间，表格结构不受影响', () => {
        const src = '| a\\|b | c |\n| - | - |\n'
        const c = openChunked(src)
        const cell = firstSpan(span(chunkedRoot(c), 0), 'tableCell')!
        const cs = cell.start + cell.node.open.length
        const ce = cell.end - cell.node.close.length
        expect(c.text.slice(cs, ce)).toBe('a\\|b')
        const next = editChunked(c, cs, ce, cellSource('新内容|带管'))
        expect(serializeChunked(next)).toBe('| 新内容\\|带管 | c |\n| - | - |\n')
    })
})

/*
 * 阅读态的判据：把 .md-meta 整段摘掉，剩下的就是屏幕上能看见的字。
 * 这一条专门盯叶子节点 —— 反引号、<>、[^] 这些在 mdast 里是和内容混在一个 value 里的，
 * 内核不剥出来，预览就会露格式码。
 */
describe('预览不露格式码', () => {
    const shown = (src: string) => render(src)
        .replace(/<span class="md-meta[^"]*">[\s\S]*?<\/span>/g, '')
        .replace(/<[^>]+>/g, '')
    const SRC = '# 标题\n\n`代码` 与 <https://a.b> 与 [^f] 与 **粗**\n\n---\n\n> 引用\n\n- 项\n'

    it('摘掉标记后正文里一个格式码都不剩', () => {
        const v = shown(SRC)
        expect(v).not.toMatch(/[#`*|>_-]/)
        expect(v).toContain('代码')
        expect(v).toContain('https://a.b')
        expect(v).toContain('引用')
    })
    /* 反证：内容本身带这些字符时不许被误剥 */
    it('剥的是定界符，不是恰好长得像的正文', () => {
        expect(shown('a `b` c\n')).toBe('a b c')
        expect(shown('10 - 2 = 8\n')).toContain('10 - 2 = 8')
        expect(shown('下划线_变量_名\n')).toContain('下划线')
    })
    it('脚注引用的标签留着，[^ 与 ] 归标记', () => {
        /* 没有对应的定义时 micromark 不认它是引用，得连着定义一起给 */
        expect(shown('正文[^f]\n\n[^f]: 定义\n')).toContain('正文f')
    })
    it('分隔线的正文是空的，整条线交给主题画', () => {
        const c = openChunked('---\n')
        const leaf = firstSpan(span(chunkedRoot(c), 0), 'thematicBreak')!
        expect(leaf.node.open).toBe('---')
        expect(leaf.node.body).toBe('')
        expect(leaf.node.close).toBe('')
    })
})

/*
 * 围栏拆解必须逐字节还原：预览里开闭围栏都藏着，拆错一个字也看不见；
 * 源码模式把它们显出来之后，闭围栏少一个换行就粘在最后一行代码后面。
 */
describe('围栏拆解不丢字节', () => {
    const codes = (n: Node): Node[] =>
        (n.type === 'code' && n.children.length === 0 ? [n] : []).concat(...n.children.map(codes))
    it('语料里每个围栏块 open+body+close 都等于它的原文', () => {
        let seen = 0
        for (const [, src] of ROUNDTRIP) for (const k of codes(chunkedRoot(openChunked(src)))) {
            const p = decomposeCode(k.body)
            if (p.open === '') continue            /* 缩进代码不拆 */
            expect(p.open + p.body + p.close, k.body).toBe(k.body)
            seen++
        }
        expect(seen, '语料里一个围栏都没有，这条等于没测').toBeGreaterThan(0)
    })
})


/*
 * 图一那种粒度：点列表的一项只换那一行的正文，`- [ ] ` 记号得留在原地。
 * 这条盯的就是"编辑框只装最小单元的字节区间"这件事。
 */
describe('最小可编辑单元', () => {
    const SRC = '- [ ] 第一项\n- [x] 第二项\n'
    it('列表项的正文是单元，区间不含 `- [ ] ` 记号', () => {
        const c = openChunked(SRC)
        const bs = blocks(c)
        const root = span(chunkedRoot(c), bs[0].start)
        const units: Span[] = []
        const walk = (s: Span): void => {
            if (s.node.type === 'paragraph') units.push(s)
            s.kids.forEach(walk)
        }
        walk(root)
        expect(units.length).toBe(2)
        for (const u of units) expect(c.text.slice(u.start, u.end)).not.toMatch(/^[-*>]/)
        const one = units[0]
        const out = renderBlocks(bs, { text: c.text, editing: 0, editRange: { start: one.start, end: one.end } })
        expect(out).toContain(`<textarea class="md-src md-eu" spellcheck="false" data-s="${one.start}" data-e="${one.end}"`)
        expect(out).toContain('<span class="md-meta">- [ ] </span>')   /* 记号还在块里，没被框吞掉 */
        expect(out.match(/<textarea/g)?.length).toBe(1)                /* 只有点的那一项变成框 */
    })
    /* 反证：不给 editRange 就退回整块换框（老行为）—— 两项一起进同一个框，列表结构不再渲染 */
    it('反证：不给区间时整块变成一个框', () => {
        const c = openChunked(SRC)
        const out = renderBlocks(blocks(c), { text: c.text, editing: 0 })
        expect(out).toContain('<textarea class="md-src"')
        expect(out).toContain('- [ ] 第一项')
        expect(out).not.toContain('md-listItem')
    })

    /*
     * 他点的是句子里那一个加粗串，不是整行："你这还是一整块啊，要只是单行的加粗的那个显示"。
     * 所以行内元素也得是单元，且框里只装那一小段的字节（含两侧记号，改了才往返全等）。
     */
    it('一个加粗串就是单元：框只装 `**页码**`，同一行别处照常渲染', () => {
        const src = '- **页码** → 每一段标记来源页码\n'
        const c = openChunked(src)
        const bs = blocks(c)
        const units: Span[] = []
        const walk = (s: Span): void => {
            if (s.node.type === 'strong') units.push(s)
            s.kids.forEach(walk)
        }
        walk(span(chunkedRoot(c), bs[0].start))
        expect(units.length).toBe(1)
        const u = units[0]
        expect(src.slice(u.start, u.end)).toBe('**页码**')
        const out = renderBlocks(bs, { text: c.text, editing: 0, editRange: { start: u.start, end: u.end } })
        expect(out).toContain(`<textarea class="md-src md-eu md-iu" spellcheck="false" data-s="${u.start}" data-e="${u.end}"`)
        expect(out.match(/<textarea/g)?.length).toBe(1)
        /* 反证之一：框里不许漏进句子的其余部分 */
        expect(out).not.toContain('<textarea**页码** →')
        expect(out).toContain('每一段标记来源页码')
        /* 反证之二：整段paragraph 没被换成框 —— 记号和同行别的字都还在 DOM 里 */
        expect(out).toContain('<span class="md-meta">- </span>')
    })

    it('行内单元类名带 md-eu，点击才命中它（而不是整块）', () => {
        const c = openChunked('a `b` [c](u) *d* **f** ~~g~~ ![i](p)\n')
        const out = renderBlocks(blocks(c), { text: c.text, editing: -1 })
        for (const cls of ['md-code-inline', 'md-link', 'md-emphasis', 'md-strong', 'md-delete', 'md-image'])
            expect(out, cls).toContain(`class="${cls} md-eu"`)
    })
})

describe('行内 HTML：白名单里的标签真的排版，别的一律按字面显示', () => {
    it('上标/下标/高亮渲染成标签本体，字仍是它自己的 span', () => {
        const out = render('x<sup>2</sup>\n')
        expect(out).toContain('<sup class="md-sup">')
        expect(out).not.toContain('&lt;sup&gt;')
        expect(render('w<mark>记</mark>\n')).toContain('<mark class="md-mark">')
        expect(render('w<sub>x</sub>\n')).toContain('<sub class="md-sub">')
    })
    it('注释整段归 md-meta：预览里不出现，露记号的时候才看得见', () => {
        expect(render('a <!-- 注 --> b\n')).toContain('<span class="md-meta">&lt;!-- 注 --&gt;</span>')
    })
    it('反证：白名单外的标签照旧按字面显示，不许悄悄放行', () => {
        const out = render('y<blink>z</blink>\n')
        expect(out).toContain('&lt;blink&gt;')
        expect(out).not.toContain('<blink>')
    })
    it('这四篇源码逐字节回得去', () => {
        for (const src of ['x<sup>2</sup>\n', 'a <!-- 注 --> b\n', 'y<blink>z</blink>\n', 'w<mark>记</mark>\n'])
            expect(serializeChunked(openChunked(src))).toBe(src)
    })
})
