import { describe, expect, it } from 'vitest'
import { parse, openChunked, chunkedRoot, serializeChunked, editChunked } from '../src/kernel/parse.ts'
import { scanTop } from '../src/kernel/split.ts'
import { mulberry, randomDocs } from './corpus.ts'
import type { Node } from '../src/kernel/node.ts'

/* 结构比较而不是只比序列化：两棵不同的树完全可能拼出同一个串 */
function shape(n: Node): unknown {
    return { t: n.type, o: n.open, s: n.sep, c: n.close, b: n.body, k: n.children.map(shape) }
}

/* 语料在 test/corpus.ts，和往返、偏移两把尺子共用同一批文档 */
const docs = randomDocs(400, 20261018)

describe('分块解析必须与整篇解析同构', () => {
    it.each(docs.map((d, i) => [i, d] as const))('随机文档 #%s', (_i, src) => {
        const chunked = openChunked(src)
        expect(shape(chunkedRoot(chunked))).toEqual(shape(parse(src).root))
        expect(serializeChunked(chunked)).toBe(src)
    })

    /* 尺子本身得有牙：先证明这个结构比较能分辨两棵不同的树 */
    it('结构比较能分辨紧列表与松列表', () => {
        expect(shape(parse('- a\n\n- b\n').root)).not.toEqual(shape(parse('- a\n- b\n').root))
    })

    it('已知的不安全空行一律不切', () => {
        const b = (s: string) => scanTop(s).bounds
        expect(b('- a\n- b\n')).toEqual([0])
        expect(b('- a\n\n- b\n')).toEqual([0])             /* 同一个松散列表 */
        expect(b('```\n\nx\n\n```\n')).toEqual([0])        /* 空行在围栏里 */
        expect(b('> a\n>\n> b\n')).toEqual([0])            /* 同一个引用（空行带 >） */
        expect(b('> a\n\n> b\n')).toEqual([0, 5])          /* 空行不带 > ⇒ 两个引用，可切 */
        expect(b('    a\n\n    b\n')).toEqual([0])         /* 同一个缩进代码 */
        expect(b('<!-- 1\n\n2 -->\n')).toEqual([0])        /* 空行在 html 类型 2 里 */
        expect(b('---\na\n\nb\n---\n')).toEqual([0, 13])   /* 空行在 frontmatter 里；它独占首区域 */
        expect(b('para\n===\n')).toEqual([0])              /* setext 下划线不是块开头 */
        expect(b('a\n\n===\n')).toEqual([0])               /* 拿不准就不切：=== 单独是段落 */
        expect(b('a\n\nb\n')).toEqual([0, 3])              /* 这才允许切 */
        expect(b('# h\n\npara\n')).toEqual([0, 5])
    })

    /*
     * 区域数这一维必须单独断言：定义行判错会让整篇塌成 1 个区域，
     * 树照样同构，差分测试看不见，只有增量粒度废了。
     */
    it('有引用定义也照切不误', () => {
        const src = 'para one\n\npara two\n\n[1]: http://u\n\npara three [1]\n'
        expect(scanTop(src).defs.length).toBe(1)
        expect(scanTop(src).bounds.length).toBeGreaterThanOrEqual(4)
        /* 定义压在段落后面（不是定义）时确实不许切 */
        expect(scanTop('文字\n[1]: u\n\n后面\n').bounds).toEqual([0])
    })

    /*
     * 已知悬崖的看门狗（#12）：GFM 脚注定义是贪吃容器，复制进区域前缀会把本区域的
     * 开头一起吞掉，所以现在"有脚注就不分块"。这条把现状钉死，是为了让修它的人必须
     * 顺手改这里，而不是修完了没人知道粒度变了。
     */
    it('含脚注定义暂时整篇不切（已知性能悬崖）', () => {
        const src = 'para one\n\nx[^a]\n\n[^a]: 内容\n\npara two\n'
        expect(scanTop(src).bounds).toEqual([0])
        expect(openChunked(src).regions.length).toBe(1)
    })
})

describe('增量编辑必须与重新打开同构', () => {
    const rand = mulberry(777)
    const pool = ['\n', '\n\n', ' ', '- ', '> ', '```', '~~~', '# ', '[^z]: n\n\n', '---\n', 'x',
        '\n\n\n', '    ', '<!--']
    const cases: [string, number, number, string][] = []
    for (let i = 0; i < 150; i++) {
        const src = randomDocs(1, 777 + i)[0]
        const from = Math.floor(rand() * src.length)
        const to = Math.min(src.length, from + Math.floor(rand() * 8))
        cases.push([src, from, to, pool[Math.floor(rand() * pool.length)]])
    }

    it.each(cases.map((c, i) => [i, c] as const))('编辑用例 #%s', (_i, [src, from, to, ins]) => {
        const next = src.slice(0, from) + ins + src.slice(to)
        const viaEdit = editChunked(openChunked(src), from, to, ins)
        expect(serializeChunked(viaEdit)).toBe(next)
        expect(shape(chunkedRoot(viaEdit))).toEqual(shape(chunkedRoot(openChunked(next))))
    })
})
