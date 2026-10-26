import { describe, expect, it } from 'vitest'
import { openChunked, blocks, serializeChunked, parse } from '../src/kernel/parse.ts'
import { renderBlocks } from '../src/render/html.ts'
import { hasMath, katexSubset, neededFamilies } from '../src/render/export.ts'
import { KATEX_CSS } from '../src/styles/katexCss.ts'
import { createActions, type Host } from '../src/app/actions.ts'
import { NOT_DONE, allItems } from '../src/app/menu.ts'
import { readFileSync } from 'node:fs'

const NL = String.fromCharCode(10)
const render = (src: string) => { const c = openChunked(src); return renderBlocks(blocks(c), { text: c.text, editing: -1 }) }

/*
 * 数学：内核、渲染、导出三层各有一条判据。
 * 最要紧的是第二条（钱数不许变公式）—— 那是"用户写的字被改没"，比公式不渲染严重。
 */
describe('数学：内核', () => {
    it('行内与块级都逐字节往返，且块级 $$$$ 自己是一块', () => {
        for (const src of ['行内 $x^2 + y_1$ 结束' + NL, '前' + NL + NL + '$$' + NL + 'a+b' + NL + '$$' + NL + NL + '后' + NL]) {
            const c = openChunked(src)
            expect(serializeChunked(c)).toBe(src)
        }
        const src = '前' + NL + NL + '$$' + NL + 'a+b' + NL + '$$' + NL
        expect(blocks(openChunked(src)).map(b => b.node.type)).toEqual(['paragraph', 'math'])
    })
    it('内侧紧贴空格的单美元不算公式：钱数不许被吃掉', () => {
        const types = (src: string) => { const out: string[] = []
            const walk = (n: any) => { if (!n.children.length) out.push(n.type); else n.children.forEach(walk) }
            walk(parse(src).root); return out }
        /* 降级后可能还是几段 text（区间一个字没动），判据是"没有 inlineMath" */
        expect(types('花 $5 买 $3 找零' + NL).filter(t => t === 'inlineMath')).toEqual([])
        expect(types('a $ b $ c' + NL).filter(t => t === 'inlineMath')).toEqual([])
        expect(types('$x$ 与 $ y $' + NL)).toEqual(['inlineMath', 'text', 'text'])
    })
    it('块级公式里有空行也不许多切一块（切了会把一个公式拆成两块）', () => {
        const src = '前' + NL + NL + '$$' + NL + 'a' + NL + NL + 'b' + NL + '$$' + NL + NL + '后' + NL
        const c = openChunked(src)
        expect(serializeChunked(c)).toBe(src)
        expect(blocks(c).map(b => b.node.type)).toEqual(parse(src).root.children.map(n => n.type))
    })
})

describe('数学：渲染与导出', () => {
    it('定界符落进 md-meta，公式体交给 KaTeX', () => {
        const out = render('看 $x^2$  end' + NL)
        expect(out).toContain('class="md-math md-eu"')
        expect(out).toContain('<span class="md-meta">$</span>')
        expect(out).toContain('class="katex"')
        expect(render('$$' + NL + 'a+b' + NL + '$$' + NL)).toContain('class="md-math-block')
    })
    it('导出的字体按这份文档用到的字集取，不用的那几只不许带上', () => {
        const plain = render('只有 $x^2$ 的行内公式' + NL)
        expect(hasMath(plain)).toBe(true)
        expect(hasMath(render('一个公式都没有' + NL))).toBe(false)
        const need = neededFamilies(plain)
        expect(need.has('KaTeX_Main')).toBe(true)
        expect(need.has('KaTeX_Math')).toBe(true)
        expect(need.has('KaTeX_Fraktur')).toBe(false)
        /* 给全用到的那几只：换完不该再留任何相对路径 */
        const all: Record<string, string> = {}
        for (const m of KATEX_CSS.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)) all[m[1]] = 'AAAA'
        const css = katexSubset(plain, all)
        expect(css).toContain('data:font/woff2;base64,AAAA')
        /* 省的是字体字，不是类规则：.katex .mathfrak{font-family:...} 那条留着无害，
         * 它的 @font-face 不许出现 —— 那才是几百 KB 的部分 */
        expect(css).not.toMatch(/@font-face\{font-family:KaTeX_Fraktur/)
        expect(css).not.toMatch(/url\(fonts\//)          /* 用到的都换成 data:，没用到的整块删掉 */
        /* 字体表没注入（读不到 app/katex/fonts.js）：留着相对路径，不许抛、也不许把 CSS 删空 */
        const fallback = katexSubset(plain, {})
        expect(fallback).toContain('url(fonts/KaTeX_Main-Regular.woff2)')
        expect(fallback.length).toBeGreaterThan(2000)
    })
    it('katexCss.ts 与 node_modules 里那份逐字节同一（防漂移，和 theme.css 同一条规矩）', () => {
        expect(KATEX_CSS).toBe(readFileSync('node_modules/katex/dist/katex.min.css', 'utf8'))
    })
    it('应用加载的是本地字体目录，不是网络', () => {
        const html = readFileSync('app/index.html', 'utf8')
        expect(html).toContain('<link rel="stylesheet" href="katex/katex.min.css">')
        expect(html).not.toMatch(/https?:\/\/[^"]*katex/i)
    })
})

describe('数学：菜单动作', () => {
    function host(src: string, sel?: [number, number]): Host & { out: string } {
        const c = openChunked(src)
        const b = blocks(c)[0]
        const h = {
            out: src, text: src, blockNode: b.node, blockRange: { start: b.start, end: b.end },
            selection: sel ? { start: sel[0], end: sel[1] } : null, renderedHtml: () => '',
            splice: (f: number, t: number, ins: string) => { h.out = h.out.slice(0, f) + ins + h.out.slice(t); h.text = h.out },
            replaceAll: (t: string) => { h.out = t; h.text = t },
            afterBlock: () => 0, atDocStart: () => 0, atDocEnd: () => 0, undo() {}, redo() {},
            fileNew() {}, fileOpen() {}, fileOpenDir() {}, save() {}, saveAs() {}, exportHtmlFile() {},
            print() {}, newWindow() {}, copy() {}, toggle() {}, findPanel() {}, fullscreen() {},
            zoom() {}, theme() {}, selectAll() {}, paste() {}, closeDoc() {}, revert() {}, speak() {},
            spellcheck() {}, lineEnding() {}, jumpTo() {}, reopenEncoding() {}, openRecent() {},
            quickOpen() {}, duplicate() {}, rename() {}, moveToDir() {}, importFile() {}, newTab() {},
            switchDocs() {}, articles() {}, help() {}, imageMode() {}, imageProps() {}, substitution() {},
            pageSetup() {},
        } as unknown as Host & { out: string }
        return h
    }
    it('行内公式包选区；没选区给一个能直接改的占位', () => {
        const a = host('正文 ab' + NL, [3, 5]); createActions(a).inlineMath?.()
        expect(a.out).toBe('正文 $ab$' + NL)
        const b = host('正文 ab' + NL); createActions(b).inlineMath?.()
        expect(b.out).toBe('$正文 ab$' + NL)
        expect(serializeChunked(openChunked(a.out))).toBe(a.out)
    })
    it('数学块把整块包成 $$ 三行；空块给 displaystyle 占位', () => {
        const a = host('公式内容' + NL); createActions(a).mathBlock?.()
        expect(a.out).toBe('$$' + NL + '公式内容' + NL + '$$' + NL)
        expect(serializeChunked(openChunked(a.out))).toBe(a.out)
        /* 空块：给一个能直接接着敲的占位，不留 $$ 中间空着 */
        const b = host('x' + NL)
        b.blockNode = { type: 'paragraph', open: '', sep: [], close: '', body: '', children: [] }
        createActions(b).mathBlock?.()
        expect(b.out).toContain('displaystyle')
    })
    it('反证：两条数学项不再是 off，也不在 NOT_DONE 里', () => {
        for (const a of ['inlineMath', 'mathBlock']) {
            expect(NOT_DONE).not.toContain(a)
            expect(allItems().filter(i => i.act === a).every(i => !i.off)).toBe(true)
        }
    })
})
