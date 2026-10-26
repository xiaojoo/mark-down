import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { math } from 'micromark-extension-math'
import { mathFromMarkdown } from 'mdast-util-math'
import type { Node as MdastNode } from 'mdast'
import { serialize, type Node } from './node.ts'
import { scanTop, type TopScan } from './split.ts'

const EXTENSIONS = {
    /* math 排在 gfm 之后：`$` 不是 GFM 的构造，两者不抢；行内 `$x$` 与块级 `$$..$$`
     * 都由这一个扩展发，节点类型是 mdast 的 inlineMath / math */
    extensions: [gfm(), frontmatter(['yaml', 'toml']), math()],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml']), mathFromMarkdown()],
}

/*
 * micromark 的 preprocess 会把 CRLF/CR 归一成 LF 并剥掉 BOM，
 * 所以它给的所有偏移都指向归一后的串 —— 原文的换行风格和 BOM 必须自己记住。
 */
export interface Doc {
    bom: string
    eol: '\r\n' | '\n'
    root: Node
}

export function splitEol(src: string): { bom: string, eol: '\r\n' | '\n', text: string } {
    const bom = src.charCodeAt(0) === 0xfeff ? '\ufeff' : ''
    const rest = src.slice(bom.length)
    return { bom, eol: rest.includes('\r\n') ? '\r\n' : '\n', text: rest.replace(/\r\n/g, '\n') }
}

/* joinEol 只需要换行风格这两项，取窄类型好让 Doc 和 Chunked 都能用 */
interface EolInfo {
    bom: string
    eol: '\r\n' | '\n'
}

export function joinEol(doc: EolInfo, text: string): string {
    return doc.bom + (doc.eol === '\n' ? text : text.split('\n').join(doc.eol))
}

function pos(n: MdastNode, base: number): [number, number] {
    const s = n.position?.start.offset
    const e = n.position?.end.offset
    if (s === undefined || e === undefined) throw new Error(`mdast 节点 ${n.type} 没有 position`)
    return [s + base, e + base]
}

function kidsOf(n: MdastNode): MdastNode[] {
    return (n as { children?: MdastNode[] }).children ?? []
}

/**
 * 夹取：兄弟节点必须按源顺序铺满 [start,end)，起点夹到前一个兄弟的末尾。
 *
 * 不能直接信 mdast 给的 start —— 实测它会把 setext 标题的区间报成连前面的
 * 定义块一起（`definition 3..16` 之后又给 `heading 3..27`），照原样用会把同
 * 一段字节数两遍。夹完仍然逐字节铺满，因为父区间一个字都没多。
 * 倒序或越界一律抛，不静默补 —— 静默补出来的树会在序列化时才错，难查得多。
 */
function clamp(parent: string, names: string[], rs: [number, number][],
    start: number, end: number): [number, number][] {
    let cursor = start
    const out: [number, number][] = []
    for (let i = 0; i < rs.length; i++) {
        const [ks0, ke] = rs[i]
        if (ke < cursor || ke > end)
            throw new Error(`${parent} [${start},${end}) 的子节点 ${names[i]} [${ks0},${ke}) 收尾倒序或越界`)
        out.push([Math.max(ks0, cursor), ke])
        cursor = ke
    }
    return out
}

/* 空隙 = 父区间减掉夹取后的全部子区间；剩下的就是源码标记 */
function tile(type: string, kids: Node[], rs: [number, number][],
    start: number, end: number, src: string): Node {
    let cursor = start
    let open = ''
    const sep: string[] = []
    rs.forEach(([ks, ke], i) => {
        if (i === 0) open = src.slice(cursor, ks)
        else sep.push(src.slice(cursor, ks))
        cursor = ke
    })
    return { type, open, sep, close: src.slice(cursor, end), body: '', children: kids }
}

/*
 * 叶子节点没有子节点可参照，标记只能从它自己的文本里剥出来。
 * mdast 把这些类型的定界符一起塞进 value，而"预览不许露出格式码"要求标记是数据不是内容，
 * 所以在这里按各自的语法把首尾切走：open + body + close 仍然逐字节等于原文。
 * 表里没有的类型（text/html/definition/frontmatter）整段都是内容，不剥。
 */
function leafMarkers(type: string, raw: string): [string, string] {
    if (type === 'inlineCode') {
        const run = /^(`+)/.exec(raw)?.[0] ?? ''
        return run !== '' && raw.length >= run.length * 2 && raw.endsWith(run) ? [run, run] : ['', '']
    }
    if (type === 'autoLink' && raw.startsWith('<') && raw.endsWith('>')) return ['<', '>']
    if (type === 'footnoteReference' && raw.startsWith('[^') && raw.endsWith(']')) return ['[^', ']']
    /* 分隔线整条都是语法：正文留空，主题想显形自己画线 */
    if (type === 'thematicBreak') return [raw, '']
    /* 公式的定界符是首尾那串 $（行内一个，块级两个）。和 inlineCode 同一套防法：
     * 首尾都得是同一串美元号才剥，否则整段当内容 —— 单边 `$5 和 $8` 不能被当成公式 */
    if (type === 'inlineMath' || type === 'math') {
        const run = /^(\$+)/.exec(raw)?.[0] ?? ''
        if (run !== '' && raw.length >= run.length * 2 && raw.endsWith(run)) return [run, run]
    }
    return ['', '']
}

function build(n: MdastNode, src: string, base: number, floor: number): Node {
    const [s0, end] = pos(n, base)
    const start = Math.max(s0, floor)
    const kids = kidsOf(n)
    if (kids.length === 0) {
        const raw = src.slice(start, end)
        const [open, close] = leafMarkers(n.type, raw)
        const body = raw.slice(open.length, raw.length - close.length)
        /* 单个 $ 的公式：内侧紧贴空格就不算（Typora 同规矩）。不挡的话"花 $5 买 $3"
         * 会被整段当成公式吃掉 —— 那是把用户写的字改没，比公式不渲染严重得多。
         * 降级成 text：区间一个字没动，逐字节往返仍然成立 */
        if (n.type === 'inlineMath' && open === close && close !== '$$' && /^\s|\s$/.test(body))
            return { type: 'text', open: '', sep: [], close: '', body: raw, children: [] }
        return { type: n.type, open, sep: [], close, body, children: [] }
    }
    const rs = clamp(n.type, kids.map(k => k.type), kids.map(k => pos(k, base)), start, end)
    return tile(n.type, kids.map((k, i) => build(k, src, base, rs[i][0])), rs, start, end, src)
}

export function parse(src: string): Doc {
    const { bom, eol, text } = splitEol(src)
    return { bom, eol, root: build(fromMarkdown(text, EXTENSIONS), text, 0, 0) }
}

export function serializeDoc(doc: Doc): string {
    return joinEol(doc, serialize(doc.root))
}

/* ---------------------------------------------------------------- 分块 */

export interface Block {
    node: Node
    start: number
    end: number
}

/**
 * 一个区域单独喂 micromark：切片解析，再把偏移整体加回基址。
 *
 * 前缀只带**别的区域里**的定义块。本区域自己就有的那条必须排除 —— 同一标签
 * 定义两遍时 micromark 按"先注册者胜"绑定，实测区域自己的 footnoteDefinition
 * 会把正文位置指到前缀里去（子节点偏移映射成负数）。
 */
function regionBlocks(text: string, from: number, to: number, defs: [number, number][]): Block[] {
    const defText = defPrefix(text, defs.filter(([s]) => s < from || s >= to))
    const base = from - defText.length
    const sub = fromMarkdown(defText + text.slice(from, to), EXTENSIONS)
    const kids = kidsOf(sub).filter(k => pos(k, base)[1] > from)
    const rs = clamp('root', kids.map(k => k.type), kids.map(k => pos(k, base)), from, to)
    return kids.map((k, i) => ({
        node: build(k, text, base, rs[i][0]), start: rs[i][0], end: rs[i][1],
    }))
}

export interface Chunked {
    bom: string
    eol: '\r\n' | '\n'
    /* 归一后的全文；所有偏移指着它，不是指着带 CRLF 的原文 */
    text: string
    defText: string
    scan: TopScan
    regions: Block[][]
}

function defPrefix(text: string, defs: [number, number][]): string {
    if (defs.length === 0) return ''
    return defs.map(([s, e]) => text.slice(s, e)).join('\n\n') + '\n\n'
}

export function openChunked(src: string): Chunked {
    const { bom, eol, text } = splitEol(src)
    return buildChunked(bom, eol, text, scanTop(text))
}

function buildChunked(bom: string, eol: '\r\n' | '\n', text: string, scan: TopScan,
    cache?: Map<string, Block[]>): Chunked {
    const regions: Block[][] = []
    for (let i = 0; i < scan.bounds.length; i++) {
        const s = scan.bounds[i]
        const e = i + 1 < scan.bounds.length ? scan.bounds[i + 1] : text.length
        /* 首区域是 frontmatter 时一个定义都不带：它只在偏移 0 才成立 */
        const defs = i === 0 && scan.frontEnd !== null ? [] : scan.defs
        regions.push(cache?.get(`${s}:${e - s}`) ?? regionBlocks(text, s, e, defs))
    }
    /* defText 当"定义集合变没变"的哨兵用，真正进解析的前缀在每个区域里另算 */
    return { bom, eol, text, defText: defPrefix(text, scan.defs), scan, regions }
}

/**
 * 顶层块的区间，保证**严格铺满全文**（后一块的起点至少等于前一块的末尾）。
 *
 * 界面按这个区间做"点开一块改源码"的 splice，所以这里比 chunkedRoot 更要紧：
 * 区间一重叠，splice 就把邻居的字节一起换掉。
 */
export function blocks(c: Chunked): Block[] {
    let cursor = 0
    const out: Block[] = []
    for (const p of c.regions.flat()) {
        if (p.end < cursor) throw new Error(`块 ${p.node.type} [${p.start},${p.end}) 倒序`)
        out.push({ node: p.node, start: Math.max(p.start, cursor), end: p.end })
        cursor = p.end
    }
    return out
}

export function chunkedRoot(c: Chunked): Node {
    const bs = blocks(c)
    return tile('root', bs.map(b => b.node), bs.map(b => [b.start, b.end]), 0, c.text.length, c.text)
}

export function serializeChunked(c: Chunked): string {
    return joinEol(c, serialize(chunkedRoot(c)))
}

/**
 * 编辑后只重算被影响的区域。
 *
 * 复用判据不靠"我以为哪几块变了"，靠 (起点, 长度) 这把钥匙：新区域能在缓存里
 * 命中，当且仅它和某个旧区域在编辑后的文本里占同一段字节 —— 而只有完全落在
 * 被替换范围之外的旧区域才进缓存，所以内容必然逐字节相同。
 *
 * 引用定义变过（增/删/改）就整篇重来：定义是全文档作用域的，一个新增的
 * `[1]: u` 会让远处某段的 `[1]` 从字面量变成链接，按区域缓存就错了。
 */
export function editChunked(c: Chunked, from: number, to: number, insert: string): Chunked {
    const delta = insert.length - (to - from)
    const text = c.text.slice(0, from) + insert + c.text.slice(to)
    const scan = scanTop(text)
    if (defPrefix(text, scan.defs) !== c.defText) return buildChunked(c.bom, c.eol, text, scan)

    const cache = new Map<string, Block[]>()
    c.regions.forEach((nodes, i) => {
        const s = c.scan.bounds[i]
        const e = i + 1 < c.scan.bounds.length ? c.scan.bounds[i + 1] : c.text.length
        if (e > from && s < to) return
        /* body/open/sep/close 是内容，不随位置变；Block 的绝对偏移必须搬家 */
        const sh = s >= to ? delta : 0
        cache.set(`${s + sh}:${e - s}`, nodes.map(p => ({
            node: p.node, start: p.start + sh, end: p.end + sh,
        })))
    })
    return buildChunked(c.bom, c.eol, text, scan, cache)
}
