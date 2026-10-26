import type { Node, Span } from '../kernel/node.ts'
import { span, serialize } from '../kernel/node.ts'
import type { Block } from '../kernel/parse.ts'
import katex from 'katex/dist/katex.min.js'

/*
 * 块树 → HTML 字符串。
 *
 * 两件契约：
 *  1. **源码标记落在 .md-meta，正文落在 .md-text** —— 显隐与配色全在 theme.css，
 *     想换皮只重写 .md-* 那组类名，不碰这一层（从 Typora 抄来的最值钱的一条分工）。
 *  2. **每个元素带 data-s / data-e（节点区间）和 data-cs / data-ce（内容区间）**。
 *     区间由内核的 span() 算出（test/span.test.ts 逐节点证明它等于 serialize），
 *     所以"点开任意子树、就地换掉它那段源码"对表格单元格、行内标记、引用里的某一段
 *     全都成立，不需要为每种元素再写一套定位。内容区间特意剔掉 open/close ——
 *     改表格单元格时不能把两侧的 `|` 一起吃掉。
 *
 * 文档里的每个字节都过 esc()：html 块也按源码文本显示，不注入。
 * Typora 是引了 DOMPurify 之后才放行原始 html 的，我们还没有那个依赖。
 */

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export function esc(s: string): string {
    return s.replace(/[&<>"]/g, c => ESC_MAP[c])
}

/* 会执行东西的地址一律拒；相对路径和 http/data:image 放行 */
const UNSAFE_SCHEME = /^\s*(?:javascript|vbscript|data:(?!image\/))/i

function at(s: Span): string {
    const cs = s.start + s.node.open.length
    const ce = s.end - s.node.close.length
    return ` data-s="${s.start}" data-e="${s.end}" data-cs="${cs}" data-ce="${ce}"`
}

function meta(text: string, cls = ''): string {
    if (text === '') return ''
    return `<span class="md-meta${cls}">${esc(text)}</span>`
}

/**
 * 续行上的容器前缀（`>` 与缩进）在解析时留在了 text 的 body 里
 * （`> a\n> b` 的段落正文就是 `a\n> b`），显示时要擦掉。
 * 只动显示，不动树 —— 序列化还得靠它逐字节回去。
 */
function cleanLine(line: string, first: boolean): string {
    if (first) return line
    return line.replace(/^[ \t]*(?:>[ \t]*)+/, '').replace(/^[ \t]{1,3}/, '')
}

export function displayText(raw: string): string {
    return raw.split('\n').map((l, i) => cleanLine(l, i === 0)).join('\n')
}

/**
 * 源码下标 → 显示下标（-1 = 这个字符不显示）。
 *
 * 关键在于 displayText **只删每行开头的字符**，所以每行就是一个后缀平移，
 * 这张表算得出来。有了它，引用块 / 列表续行里的命中也能画对高亮 ——
 * 之前按"长度相等"一刀切，实测 `> [!NOTE] 标记留在源码里` 那个命中就漏画了。
 */
function displayMap(body: string): Int32Array {
    const map = new Int32Array(body.length).fill(-1)
    let so = 0, doff = 0
    body.split('\n').forEach((line, i) => {
        const shown = cleanLine(line, i === 0)
        const t = line.length - shown.length
        for (let j = t; j < line.length; j++) map[so + j] = doff + (j - t)
        so += line.length + 1
        doff += shown.length + 1
    })
    return map
}

/** 单元格里的可见文本 → 能塞回源码的串：竖线转义、换行折成空格 */
export function cellSource(visible: string): string {
    return visible.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

/* 围栏代码：raw = 开围栏行 + 正文 + 闭围栏行。lang 单独给出来，着色和编辑都要用 */
export interface CodeParts {
    open: string, lang: string, body: string, close: string
}
export function decomposeCode(raw: string): CodeParts {
    const nl = raw.indexOf('\n')
    const first = nl === -1 ? raw : raw.slice(0, nl)
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(first)
    if (!m) return { open: '', lang: '', body: raw, close: '' }      /* 缩进代码 */
    const open = nl === -1 ? raw : raw.slice(0, nl + 1)
    const rest = nl === -1 ? '' : raw.slice(nl + 1)
    /* 闭围栏是最后一段"只有围栏字符"的行；未闭合的围栏就没有 close */
    const lines = rest.split('\n')
    let close = ''
    let bodyLines = lines
    for (let i = lines.length - 1; i > 0; i--) {
        if (/^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(lines[i]) && lines[i].trim()[0] === m[1][0]) {
            /* 连它前面那个换行一起算进 close：open+body+close 必须逐字节等于 raw，
             * 否则源码模式下闭围栏会粘在最后一行代码后面（预览里两个都藏着，看不见） */
            close = '\n' + lines[i]
            bodyLines = lines.slice(0, i)
            break
        }
    }
    return { open, lang: m[2].trim(), body: bodyLines.join('\n'), close }
}

/*
 * 行内还是块，由类型决定而不是由"谁调我"决定：早先所有孩子都走块渲染器，
 * 结果段落里的 ![猫](cat.png) 被当成块叶子吐成源码文本，text 还被套了两层。
 */
const INLINE = new Set(['text', 'emphasis', 'strong', 'delete', 'inlineCode', 'link', 'image',
    'break', 'html', 'autolink', 'linkReference', 'footnoteReference', 'inlineMath'])

function kids(s: Span, ctx: Ctx): string {
    return s.kids.map((k, i) =>
        (i === 0 ? '' : meta(s.node.sep[i - 1])) + renderNode(k, ctx)).join('')
}

function renderNode(s: Span, ctx: Ctx): string {
    return INLINE.has(s.node.type) ? renderInline(s, ctx) : renderBlock(s, ctx)
}

/* 命中高亮：marks 是源码区间，current 指着当前那一个 */
export interface Mark {
    start: number
    end: number
}
interface Ctx {
    marks: Mark[]
    current: Mark | null
    text: string
    /* 正在编辑的最小单元（见 UNITS）：命中它就把那一段换成文本域，别处照常渲染 */
    edit: Mark | null
}
const NO_CTX: Ctx = { marks: [], current: null, text: '', edit: null }

/*
 * 最小可编辑单元 = 图一那种粒度：点列表的一项只改那一项、点引用里的一段只改那一段，
 * 而 `- `、`> ` 这些记号留在原位不动（它们属于父节点，不在这一段的字节区间里）。
 * 表格格子另走 .md-body 那条路（两侧的分隔管不能被光标碰到）。
 */
const UNITS = new Set(['paragraph', 'heading', 'code', 'html', 'thematicBreak', 'definition', 'yaml', 'toml', 'math'])

/* 行内元素也算单元：他点的是 `**页码**` 那一个加粗串，不是整行、更不是整块。
 * 命中它就把这一小段换成一个行内大小的框，同一行别的内容照常渲染。 */
const INLINE_UNITS = new Set(['emphasis', 'strong', 'delete', 'inlineCode', 'link', 'image', 'inlineMath'])

/** 一段源码就地换成文本域。行内单元再带一个 md-iu：宽高各归各钉（见 focusBlock） */
function unitBox(s: Span, ctx: Ctx, inline = false): string {
    const raw = ctx.text.slice(s.start, s.end)
    return `<textarea class="md-src md-eu${inline ? ' md-iu' : ''}" spellcheck="false" `
        + `data-s="${s.start}" data-e="${s.end}" `
        + `rows="${raw.split('\n').length}">${esc(raw)}</textarea>`
}

/** 把命中从源码区间换算到显示串上，再切片包 <mark> */
function marked(body: string, shown: string, cs: number, ctx: Ctx): string {
    if (ctx.marks.length === 0) return esc(shown)
    const map = displayMap(body)
    const segs: [number, number, number][] = []
    for (const h of ctx.marks) {
        if (h.end <= cs || h.start >= cs + body.length) continue
        const a = map[h.start - cs]
        const last = map[Math.min(h.end, cs + body.length) - 1 - cs]
        if (a < 0 || last < 0) continue
        segs.push([a, last - a + 1, h.start])
    }
    segs.sort((x, y) => x[0] - y[0])
    let out = ''
    let at = 0
    for (const [s, len, src] of segs) {
        if (s < at) continue
        /* 比的是源码起点，不能用 cs + 显示下标 —— 续行上擦掉的 `>` 会让两者错开 */
        const isCur = !!ctx.current && ctx.current.start === src
        out += esc(shown.slice(at, s))
        out += `<mark class="md-hit${isCur ? ' md-hit-current' : ''}">${esc(shown.slice(s, s + len))}</mark>`
        at = s + len
    }
    return out + esc(shown.slice(at))
}

/** 原样显示的串（块叶子、代码正文）：源码下标和显示下标一一对应 */
function verbatim(text: string, cs: number, ctx: Ctx): string {
    return marked(text, text, cs, ctx)
}

/**
 * 公式：源码里的 $..$ / $$..$$ 交给 KaTeX 排版。
 * throwOnError:false —— 写错的公式要就地显出"这里错了"，不许把整篇渲染打断；
 * output 带 MathML —— 读屏器和复制粘贴都靠它，只留视觉那一层是给不看见的人使坏。
 */
export function mathHtml(tex: string, display: boolean): string {
    try {
        return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' })
    } catch {
        /* katex 连错误框都造不出来（版本不对等）：退回源码，一个字都不丢 */
        const fence = display ? '$$' : '$'
        return `<span class="md-math-bad">${esc(fence + tex + fence)}</span>`
    }
}

function renderInline(s: Span, ctx: Ctx): string {
    const n = s.node
    /* 他点的是 `**页码**` 那一个加粗串：命中它就把这一小段换成行内大小的框，
     * 同一行别的内容照常渲染（粒度比整段还细，所以放在行内分派的最前面） */
    if (ctx.edit && INLINE_UNITS.has(n.type) && s.start === ctx.edit.start && s.end === ctx.edit.end)
        return unitBox(s, ctx, true)
    const eu = INLINE_UNITS.has(n.type) ? ' md-eu' : ''
    if (n.type === 'text') {
        const shown = displayText(n.body)
        const cs = s.start + n.open.length
        const plain = shown.length === n.body.length
        /* data-plain 管的是**选区**能不能按字符数换算回源码（只认逐字符等长的格子）；
         * 高亮走 displayMap，续行上被擦掉的 `>` 也能算回来，所以两者不能合并成一个判据 */
        return meta(n.open) + `<span class="md-text"${at(s)}${plain ? ' data-plain="1"' : ''}>`
            + marked(n.body, shown, cs, ctx) + '</span>' + meta(n.close)
    }
    if (n.type === 'inlineCode')
        return `<span class="md-code-inline${eu}"${at(s)}>${meta(n.open)}<span class="md-text">`
            + `${verbatim(n.body, s.start + n.open.length, ctx)}</span>${meta(n.close)}</span>`
    if (n.type === 'break')
        return meta(n.open) + `<br class="md-br">` + meta(n.close)
    /* 公式：定界符仍按契约落进 .md-meta（露记号时看得见），中间换成 KaTeX 的排版 */
    if (n.type === 'inlineMath')
        return `<span class="md-math md-eu"${at(s)}>${meta(n.open)}`
            + mathHtml(n.body, false) + meta(n.close) + '</span>'
    /*
     * 行内 HTML：上标/下标/高亮这三条命令插的就是 <sup>/<sub>/<mark>（Typora 也是 HTML 标签，
     * 不是自造语法），标签和标签之间的字在树里是**兄弟节点**，所以这里逐节点放行。
     * 只放白名单里的：别的标签照旧按字面显示。代价是有人手写一个只开不闭的 <sup> 时，
     * 这一段后面都会跟着变上标 —— 真 HTML 的语义就是这样，我们发的命令永远成对。
     */
    if (n.type === 'html') {
        const raw = (n.open + n.body + n.close).trim()
        /* 注释整段算"标记"：预览里干脆不出现，露记号（源码/显示格式码）的时候才看到 */
        if (/^<!--[\s\S]*-->$/.test(raw)) return meta(raw)
        /* 斜杠在正则字面量里必须转义：写 (/?) 的话字面量到 <( 就结束，整行崩在下一行 */
        const tag = /^<(\/?)(sup|sub|mark|kbd|u|s|small)\s*>$/.exec(raw)
        if (tag) return tag[1] ? `</${tag[2]}>` : `<${tag[2]} class="md-${tag[2]}">`
    }
    if (n.type === 'image') {
        /* raw = ![alt](src "title")，叶子没有子节点，自己拆 */
        const m = /^(!\[)([^\]]*)(\]\()([^)\s]*)([^)]*\))$/.exec(n.open + n.body + n.close)
        if (m && !UNSAFE_SCHEME.test(m[4]))
            return `<span class="md-image${eu}"${at(s)}>${meta(m[1])}<img class="md-img" src="${esc(m[4])}" alt="${esc(m[2])}">`
                + `${meta(m[3] + m[4] + m[5], ' md-image-src')}</span>`
    }
    if (n.children.length === 0)
        /* 叶子行内（自动链接、脚注引用、拆不动的图片）：定界符归标记，标签本身仍是内容 */
        return `<span class="md-${n.type}${eu}"${at(s)}>${meta(n.open)}`
            + verbatim(n.body, s.start + n.open.length, ctx) + meta(n.close) + '</span>'
    return `<span class="md-${n.type}${eu}"${at(s)}>${meta(n.open)}${kids(s, ctx)}${meta(n.close)}</span>`
}

/*
 * 树里没有 depth —— 级别本来就在源码标记里，从标记反推比再存一份强：
 * atx 看 open 的井号串，setext 看 close 的下划线是 = 还是 -。
 */
function headingLevel(n: Node): number {
    const atx = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(n.open)
    if (atx) return atx[1].length
    const setext = /\n {0,3}(=+|-+)[ \t]*$/.exec(n.close)
    return setext ? (setext[1][0] === '=' ? 1 : 2) : 1
}

/* Typora/GitHub 的提示块：> [!NOTE]，标记留在源码里，只显示成一块带色的框 */
const ALERTS = ['note', 'tip', 'important', 'warning', 'caution']
function alertKind(n: Node): string {
    if (n.type !== 'blockquote') return ''
    const first = n.children[0]
    const text = first && first.children[0] ? first.children[0].body : ''
    const m = /^\s*\[!(\w+)\][ \t]*\n?/.exec(text)
    const k = m ? m[1].toLowerCase() : ''
    return ALERTS.includes(k) ? k : ''
}

function renderBlock(s: Span, ctx: Ctx): string {
    const n = s.node
    const eu = UNITS.has(n.type) ? ' md-eu' : ''
    if (ctx.edit && eu && s.start === ctx.edit.start && s.end === ctx.edit.end) return unitBox(s, ctx)
    if (n.type === 'math')
        return `<div class="md-math-block${eu}"${at(s)}>${meta(n.open)}`
            + mathHtml(n.body.trim(), true) + meta(n.close) + '</div>'
    if (n.type === 'code') {
        const c = decomposeCode(n.body)
        if (c.open)
            return `<pre class="md-code${eu}"${at(s)} data-lang="${esc(c.lang)}">${meta(c.open, ' md-fence')}`
                + `<code class="md-text">${verbatim(c.body, s.start + c.open.length, ctx)}</code>`
                + `${meta(c.close, ' md-fence')}</pre>`
        return `<pre class="md-code md-indent${eu}"${at(s)}>${meta(n.body)}</pre>`
    }
    if (n.children.length === 0) {
        /* 块叶子（html 块 / frontmatter / 分隔线 / 引用定义）：标记归标记，正文归正文 */
        return `<div class="md-${n.type}${eu}"${at(s)}>${meta(n.open)}`
            + verbatim(n.body, s.start + n.open.length, ctx) + meta(n.close) + '</div>'
    }
    /*
     * 单元格：正文单独包一层 .md-body，并把要替换的字节区间标在它身上。
     * 实测把 contenteditable 直接设在格子上，光标就能碰见两侧的 `|`（那时
     * textContent 读回来是 "| 类型 "），就地编辑会把分隔管一起改掉或复制成 `||`。
     */
    if (n.type === 'tableCell') {
        const cs = s.start + n.open.length
        const ce = s.end - n.close.length
        return `<div class="md-tableCell"${at(s)}>${meta(n.open)}`
            + `<span class="md-body" data-b="${cs},${ce}">${kids(s, ctx)}</span>${meta(n.close)}</div>`
    }
    /* 级别类名挂在**块外层**上：编辑态没有里面这层 div，挂在里面的话
     * 点下去 textarea 就退回正文字号（h1 是 1.9em），41px 的框里飘一行 16px 的字 */
    let cls = (n.type === 'heading' ? 'md-heading' : `md-${n.type}`) + eu
    const a = alertKind(n)
    if (a) cls += ` md-alert md-alert-${a}`
    /* 表格列数由内核数出来交给主题（--md-cols）：每行各排各的 grid 会列宽不齐，
     * 实测同一列在三行里分别在 350 / 395 / 347 px。外观仍然只在 CSS 里决定。 */
    const cols = n.type === 'table'
        ? ` style="--md-cols:${n.children[0]?.children.length ?? 1}"` : ''
    return `<div class="${cls}"${at(s)}${cols}>${meta(n.open)}${kids(s, ctx)}${meta(n.close)}</div>`
}

export interface RenderOpts {
    /* 正在编辑的块序号：那块直接换成可写的源码文本域 */
    editing?: number
    text: string
    /* 查找命中（源码区间）与当前那一个：命中的块带 md-hit-block，便于滚动定位 */
    marks?: Mark[]
    current?: number
    /* 正在编辑的最小单元区间（见 UNITS）。不给 = 整块换成文本域（老行为） */
    editRange?: Mark
}

export function renderBlocks(bs: Block[], opts: RenderOpts): string {
    const marks = opts.marks ?? []
    const cur = opts.current != null && opts.current >= 0 ? marks[opts.current] : null
    const ctx: Ctx = { marks, current: cur ?? null, text: opts.text, edit: opts.editRange ?? null }
    const inBlock = (b: Block, m: Mark | null) => !!m && m.start >= b.start && m.start < b.end
    return bs.map((b, i) => {
        let cls = `md-block md-${b.node.type}-block`
        /* 级别类放外层：预览和编辑态必须同一字号（见 renderBlock 里那条注释） */
        if (b.node.type === 'heading') cls += ` md-h${headingLevel(b.node)}`
        if (marks.some(m => inBlock(b, m))) cls += ' md-hit-block'
        if (inBlock(b, cur)) cls += ' md-hit-current'
        /* 尾部空行不进 textarea（多一行空行就比预览高一截，量出来 20.4px），
         * 只记个数，提交时原样接回去。
         * data-new：待插入的空块区间是零宽，它的 data-s 和后面那块一模一样，
         * 不标出来，提交这个空框会按起点找到**隔壁那块**并把它抹掉（实测丢过一条引用定义）。 */
        const raw = opts.text.slice(b.start, b.end)
        const tail = (/\n*$/.exec(raw) ?? [''])[0].length
        const shown = raw.slice(0, raw.length - tail)
        /* 点的那一段就是整块（整段正文、单个标题…）才整块换框；否则块照常渲染，
         * 只把命中的那一小段换成框 —— 父节点的记号（`- `、`> `）留在原地不动 */
        const whole = !opts.editRange || (opts.editRange.start === b.start && opts.editRange.end === b.end)
        if (opts.editing === i && whole) {
            const isNew = b.start === b.end
            return `<div class="${cls} md-editing" data-i="${i}" data-s="${b.start}" data-e="${b.end}"`
                + `${isNew ? ' data-new="1"' : ''}>`
                + `<textarea class="md-src" spellcheck="false" data-s="${b.start}" data-e="${b.end}"`
                + ` data-tail="${tail}" rows="${shown.split('\n').length}">${esc(shown)}</textarea></div>`
        }
        return `<div class="${cls}${opts.editing === i ? ' md-editing' : ''}" data-i="${i}" tabindex="0">`
            + renderNode(span(b.node, b.start), ctx) + '</div>'
    }).join('')
}

/* 自检口：渲染器发出的区间必须真的指回那段源码（浏览器里也能一把量） */
export function checkRanges(bs: Block[], text: string): string[] {
    const bad: string[] = []
    for (const b of bs) {
        const s = span(b.node, b.start)
        if (text.slice(s.start, s.end) !== serialize(b.node)) bad.push(`块 ${b.node.type} 区间不符`)
    }
    return bad
}
