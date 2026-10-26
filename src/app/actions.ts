import { serialize, type Node } from '../kernel/node.ts'

/*
 * 菜单项背后的动作。逻辑全放这里、DOM 全留在 main.ts，为的是这些行为能在 Node 里
 * 用一台假宿主直接量（见 test/menu.test.ts）—— 菜单条最容易烂掉的地方就是"看着有、
 * 点了没反应"，那必须能在不开浏览器的情况下被抓住。
 */
export interface Host {
    text: string
    blockNode: Node | null
    blockRange: { start: number, end: number } | null
    selection: { start: number, end: number } | null
    splice(from: number, to: number, ins: string): void
    replaceAll(t: string): void
    afterBlock(ins: string): void
    atDocStart(ins: string): void
    atDocEnd(ins: string): void
    undo(): void
    redo(): void
    fileNew(): void
    fileOpen(): void
    fileOpenDir(): void
    save(): void
    saveAs(): void
    exportHtmlFile(): void
    print(): void
    newWindow(): void
    copy(text: string): void
    renderedHtml(): string
    toggle(name: string): void
    findPanel(replace: boolean): void
    fullscreen(): void
    zoom(dir: number): void
    theme(name: string): void
    /* ---- A 批：这些动作的落点在 DOM / 宿主那边，接口先在这里说清楚 ---- */
    selectAll(): void
    paste(plain: boolean): void
    closeDoc(): void
    revert(): void
    speak(text: string): void
    spellcheck(): void
    lineEnding(eol: 'lf' | 'crlf' | 'cr'): void
    jumpTo(heading: number): void
    /* ---- C 批：文件那半边 ---- */
    reopenEncoding(enc: string): void
    openRecent(name: string): void
    quickOpen(): void
    duplicate(): void
    rename(): void
    moveToDir(): void
    importFile(): void
    /* ---- D 批：标签 / 文章列表 / 帮助 ---- */
    newTab(): void
    switchDocs(which: string): void
    articles(): void
    help(): void
    /* ---- E 批：图片工具 / 智能替换 / 页面设置 ---- */
    imageMode(mode: 'natural' | 'fit'): void
    imageProps(): void
    substitution(id: string): void
    pageSetup(): void
}

/**
 * 一个块的"行内源码"：剔掉块自己那对 open/close，其余按原样拼。
 * 星号下划线这类标记存在**子容器**的 open/close 上（`**粗**` 的 emphasis 节点
 * open=`**`、close=`**`），所以孩子一律用 serialize —— 早先递归调 inlineSource
 * 把每层的标记都剥掉了，量出来 '段落 粗' 而不是 '段落 **粗**'。
 */
export function inlineSource(n: Node): string {
    if (n.children.length === 0) return n.body
    let s = ''
    n.children.forEach((c, i) => {
        if (i > 0) s += n.sep[i - 1]
        s += serialize(c)
    })
    return s
}

const lines = (s: string): string[] => s.split('\n')

/** 把当前块换成另一种块级形态；没有可定位的块就不动。
 *  块区间本身不含尾随换行，所以这里造出来的串也不带 —— 多一个就凭空多一个空行 */
function reBlock(h: Host, make: (text: string) => string): void {
    if (!h.blockNode || !h.blockRange) return
    const text = inlineSource(h.blockNode).replace(/\n+$/, '')
    h.splice(h.blockRange.start, h.blockRange.end, make(text))
}

function wrap(h: Host, open: string, close: string, placeholder: string): void {
    const sel = h.selection
    if (sel && sel.end > sel.start) {
        const inner = h.text.slice(sel.start, sel.end)
        h.splice(sel.start, sel.end, open + inner + close)
    } else if (h.blockRange) {
        const inner = inlineSource(h.blockNode!).replace(/\n+$/, '')
        h.splice(h.blockRange.start, h.blockRange.end, open + (inner || placeholder) + close)
    }
}

/**
 * 只对"被光标或选区盖到的那几行"做变换 —— 列表缩进要的就是这个：
 * 光标在第二项上，只把第二项嵌下去，别的一项不许跟着走（Typora 就是这个行为）。
 * 块的字节区间是现成的，行边界按 \n 数出来就够，不用再走一遍树。
 */
/** 这一行第一个字符的下标 */
function lineStartOf(text: string, pos: number): number {
    const i = text.lastIndexOf('\n', pos - 1)
    return i < 0 ? 0 : i + 1
}

function reLines(h: Host, f: (line: string) => string): void {
    if (!h.blockRange) return
    const { end } = h.blockRange
    /*
     * 块的区间不含行首缩进：`  - a` 那个列表项的节点从 `-` 才开始（前面两个空格不在任何节点里，
     * 是 parse 按 span 量出来的，量过：区间 = [2,11)）。不抬到行首，列表退格就永远退不掉
     * 第一项 —— 所以只在"这段前缀确实全是空白"时才抬。
     */
    const ls = lineStartOf(h.text, h.blockRange.start)
    const start = /^[ \t]*$/.test(h.text.slice(ls, h.blockRange.start)) ? ls : h.blockRange.start
    const raw = h.text.slice(start, end)
    /* 没有选区 = 从菜单点的（那一刻编辑框已经提交、DOM 选区也没了）→ 整块每行都算命中。
     * 让 from 保持负数就是这个意思；光标/选区在块里时只挑盖到的那几行。 */
    const sel = h.selection
    const from = sel ? Math.min(sel.start, sel.end) : -1
    const to = sel ? Math.max(sel.start, sel.end) : -1
    let pos = start
    const out = raw.split('\n').map(l => {
        const lineEnd = pos + l.length
        const hit = from < 0 || (lineEnd >= from && pos <= to)
        pos = lineEnd + 1
        return hit ? f(l) : l
    })
    h.splice(start, end, out.join('\n'))
}

/** 行内链接 → 引用式：`[文字](url "题")` 变 `[文字][n]`，定义另发一行。
 *  前面带 ! 的图片不许动（那是 `![alt](src)`，正则不挡就会一起改掉）。 */
export function toReference(t: string, from = 1): { body: string, defs: string[] } {
    const defs: string[] = []
    let n = from
    const body = t.replace(/(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+("[^"]*"))?\s*\)/g,
        (_all, label: string, url: string, title?: string) => {
            const id = String(n++)
            defs.push(`[${id}]: ${url}${title ? ' ' + title : ''}`)
            return `[${label}][${id}]`
        })
    return { body, defs }
}

/** 下一个没被占用的数字标号（引用式链接的定义用） */
export function nextRefId(text: string): number {
    const used = new Set([...text.matchAll(/^\[([0-9]+)\]:/gm)].map(m => m[1]))
    let n = 1
    while (used.has(String(n))) n++
    return n
}

/** 下一个没被占用的脚注编号：看的是文末的定义，不是引用（引用可以重复指同一个） */
export function nextFootnote(text: string): number {
    const used = new Set([...text.matchAll(/^\[\^([^\][\s]+)\]:/gm)].map(m => m[1]))
    let n = 1
    while (used.has(String(n))) n++
    return n
}

/*
 * 清除格式：把行内容器的记号剥掉，只留字。
 * 认不出来的类型一律原样 serialize —— 宁可某一种格式没清掉，也不许把字吃掉，
 * 所以这里用白名单而不是黑名单。行内 HTML（上标/下标/高亮那三个尖括号标签）算格式，
 * 清掉标签、标签之间的字是它的兄弟 text 节点，本来就会留下。
 */
const STRIPPABLE = new Set(['emphasis', 'strong', 'delete', 'inlineCode'])

export function clearInline(n: Node): string {
    if (n.type === 'html') return ''
    /* 图片在树里是个叶子，整段 `![猫](cat.png)` 都在 body 上（链接才是带孩子的容器）。
     * 所以这里自己拆：拆不出来就整段原样留着 —— 宁可某一种格式没清掉，也不许把字吃掉。 */
    if (n.type === 'image') {
        const m = /^!\[([^\]]*)\]\(/.exec(n.body)
        return m ? m[1] : serialize(n)
    }
    if (n.type === 'link') return kidsStripped(n)
    if (STRIPPABLE.has(n.type)) return n.children.length ? kidsStripped(n) : n.body
    if (n.children.length === 0) return n.type === 'text' ? n.body : serialize(n)
    /* 认不出的容器（段落、引用、列表项……）：块级记号原样留着，孩子照样清。
     * 早先这里直接 serialize，于是一整段原样吐回来 = 一条都没清掉。 */
    return n.open + n.children.map((c, i) => (i > 0 ? n.sep[i - 1] : '') + clearInline(c)).join('') + n.close
}

function kidsStripped(n: Node): string {
    let s = ''
    n.children.forEach((c, i) => {
        if (i > 0) s += n.sep[i - 1]
        s += clearInline(c)
    })
    return s
}

/** 无格式粘贴：把 Markdown 的行内记号按字面量贴进去，不让它被当成语法重新解析 */
export function escapeMd(t: string): string {
    return t.replace(/[\\`*_~[\]()#!<>|&]/g, c => '\\' + c)
}

/** 换行符：内存里永远是 \n，只有写盘/复制出去的那一份按选定的 EOL 落地 */
export function toEol(text: string, eol: 'lf' | 'crlf' | 'cr'): string {
    const nl = eol === 'lf' ? '\n' : eol === 'crlf' ? '\r\n' : '\r'
    return text.replace(/\r\n?|\n/g, nl)
}

/** 跳到：标题清单（给子菜单当内容，也给动作当序号表） */
export function headings(text: string): { level: number, title: string, at: number }[] {
    const out: { level: number, title: string, at: number }[] = []
    let at = 0
    for (const raw of text.split('\n')) {
        const m = /^(#{1,6}) +(.*)$/.exec(raw)
        if (m) out.push({ level: m[1].length, title: m[2].trim() || '（空标题）', at })
        at += raw.length + 1
    }
    return out
}

/** 当前该复制/朗读的那一段字：有选区取选区，没有就取光标所在那一整块的源码 */
export function targetText(h: Host): string {
    const s = h.selection
    if (s && s.end > s.start) return h.text.slice(s.start, s.end)
    if (h.blockNode) return inlineSource(h.blockNode).replace(/\n+$/, '')
    return h.text
}

/** 粘贴的落点：选区（哪怕折叠成光标）优先，其次当前块末尾，最后文末 */
function pasteAt(h: Host): { from: number, to: number } {
    const s = h.selection
    if (s) return { from: s.start, to: s.end }
    if (h.blockRange) return { from: h.blockRange.end, to: h.blockRange.end }
    return { from: h.text.length, to: h.text.length }
}

/** 无格式粘贴不许把段落整个吞掉：贴到块里时把换行折成空格 */
function pasteInto(h: Host, ins: string): void {
    const { from, to } = pasteAt(h)
    const inBlock = !!h.blockRange && from >= h.blockRange.start && from <= h.blockRange.end
    /* 折行之后两头那点空白是换行变出来的，不是用户写的，去掉 */
    const tidy = ins.replace(/\n+/g, ' ').replace(/^ +| +$/g, '')
    h.splice(from, to, inBlock ? tidy : ins)
}

/** 宿主把剪贴板文本弄到手之后一律走这里：落点、转义、换行折叠都只认这一处 */
export function insertText(h: Host, raw: string, plain: boolean): void {
    pasteInto(h, plain ? escapeMd(raw) : raw)
}

export function createActions(h: Host): Record<string, (arg?: string) => void> {
    const acts: Record<string, (arg?: string) => void> = {
        new: () => h.fileNew(),
        newWindow: () => h.newWindow(),
        open: () => h.fileOpen(),
        openDir: () => h.fileOpenDir(),
        save: () => h.save(),
        saveAs: () => h.saveAs(),
        exportHtml: () => h.exportHtmlFile(),
        print: () => h.print(),

        undo: () => h.undo(),
        redo: () => h.redo(),
        copyMarkdown: () => h.copy(h.text),
        copyHtml: () => h.copy(h.renderedHtml()),

        /* 复制/剪切 = 当前该管的那一段（见 targetText）：没选东西就是整块，Typora 也是这样 */
        copy: () => h.copy(targetText(h)),
        cut: () => {
            const s = h.selection
            if (s && s.end > s.start) { h.copy(h.text.slice(s.start, s.end)); h.splice(s.start, s.end, '') }
            else h.copy(targetText(h))
        },
        paste: () => h.paste(false),
        pastePlain: () => h.paste(true),
        selectAll: () => h.selectAll(),

        /* 清除格式：整块剥记号。只做选区的话要把偏移映射回子树，代价大、收益小 ——
         * 一块之内格式通常就是同一套，清整块是看得懂的行为 */
        clearFormat: () => {
            if (!h.blockNode || !h.blockRange) return
            h.splice(h.blockRange.start, h.blockRange.end, clearInline(h.blockNode))
        },

        close: () => h.closeDoc(),
        revertTo: () => h.revert(),
        speech: () => h.speak(targetText(h)),
        spelling: () => h.spellcheck(),
        lineEnding: arg => h.lineEnding(arg === 'crlf' || arg === 'cr' ? arg : 'lf'),
        jumpTo: arg => h.jumpTo(Number(arg ?? -1)),
        reopenWithEncoding: arg => h.reopenEncoding(arg ?? 'utf-8'),
        openRecent: arg => h.openRecent(arg ?? ''),
        quickOpen: () => h.quickOpen(),
        duplicate: () => h.duplicate(),
        rename: () => h.rename(),
        moveTo: () => h.moveToDir(),
        import: () => h.importFile(),
        newTab: () => h.newTab(),
        switchDocs: which => h.switchDocs(which ?? ''),
        articles: () => h.articles(),
        help: () => h.help(),
        imageNatural: () => h.imageMode('natural'),
        imageFit: () => h.imageMode('fit'),
        imageProps: () => h.imageProps(),
        substitution: id => h.substitution(id ?? ''),
        pageSetup: () => h.pageSetup(),

        h1: () => reBlock(h, t => `# ${t}`),
        h2: () => reBlock(h, t => `## ${t}`),
        h3: () => reBlock(h, t => `### ${t}`),
        h4: () => reBlock(h, t => `#### ${t}`),
        h5: () => reBlock(h, t => `##### ${t}`),
        h6: () => reBlock(h, t => `###### ${t}`),
        paragraph: () => reBlock(h, t => t),
        quote: () => reBlock(h, t => lines(t).map(l => `> ${l}`).join('\n')),
        ul: () => reBlock(h, t => lines(t).map(l => `- ${l}`).join('\n')),
        ol: () => reBlock(h, t => lines(t).map((l, i) => `${i + 1}. ${l}`).join('\n')),
        task: () => reBlock(h, t => lines(t).map(l => `- [ ] ${l}`).join('\n')),
        codeFence: () => reBlock(h, t => '```\n' + t + '\n```'),
        table: () => h.afterBlock('|  |  |\n| - | - |\n|  |  |\n'),
        hr: () => h.afterBlock('***\n'),
        toc: () => h.afterBlock(tocOf(h.text) + '\n'),
        yaml: () => h.atDocStart('---\n---\n'),

        strong: () => wrap(h, '**', '**', '粗体'),
        emphasis: () => wrap(h, '*', '*', '斜体'),
        underline: () => wrap(h, '_', '_', '下划线'),
        code: () => wrap(h, '`', '`', '代码'),
        strike: () => wrap(h, '~~', '~~', '删除'),

        /*
         * 上标/下标/高亮插的是 HTML 标签（Typora 也是），不自造语法：导出的 HTML 和别的
         * Markdown 工具都认，内核也不用加构造 —— 标签与标签之间的字在树里是兄弟节点，
         * 渲染那一边按白名单放行（见 render/html.ts 的 html 分支）。
         */
        highlight: () => wrap(h, '<mark>', '</mark>', '高亮'),
        superscript: () => wrap(h, '<sup>', '</sup>', '上标'),
        subscript: () => wrap(h, '<sub>', '</sub>', '下标'),
        /* 注释：Typora 写 %%..%%（它自造的），这里写标准 HTML 注释 —— 同一件事：
         * 预览里不显示、露记号时才看得见，而且任何 Markdown 工具都读得回去。 */
        comment: () => wrap(h, '<!-- ', ' -->', '注释'),

        /* 公式：行内 $..$、块级 $$..$$。内侧不挨空格才认（见 kernel/parse.ts 的降级），
         * 所以这里插入时给的是 $x^2$ 这种两侧都贴着字的写法 */
        inlineMath: () => wrap(h, '$', '$', 'x^2'),
        mathBlock: () => reBlock(h, t => '$$\n' + (t.trim() || '\\displaystyle ') + '\n$$'),
        link: () => wrap(h, '[', '](https://)', '链接文字'),
        image: () => wrap(h, '![', '](https://)', '图片描述'),

        /* 列表缩进/退格：只动光标（或选区）盖到的那几行，两个空格一档。
         * 注意 4 个空格在 Markdown 里是缩进代码块 —— 普通段落连按两次缩进就会变成代码，
         * 那是语法本身的意思，不是这里写错了。 */
        indent: () => reLines(h, l => `  ${l}`),
        outdent: () => reLines(h, l => l.replace(/^ {1,2}/, '')),

        /* 链接引用：这一行里的 [文字](url) 全部改成引用式，定义补在下面；
         * 一个行内链接都没有时，就把整行做成一个引用式链接（点了必须有反应）。 */
        linkReference: () => reBlock(h, t => {
            const id = nextRefId(h.text)
            const r = toReference(t, id)
            if (r.defs.length) return `${r.body}\n\n${r.defs.join('\n')}`
            const label = t.replace(/\s+/g, ' ').trim() || '链接文字'
            return `[${label}][${id}]\n\n[${id}]: https://`
        }),

        /* 脚注：正文里插 [^n]，文末开一条 [^n]: 。选中一段文字时，那段被搬进脚注里，
         * 正文只留引用 —— Typora 就是这个行为。 */
        footnotes: () => {
            const n = nextFootnote(h.text)
            const sel = h.selection
            if (sel && sel.end > sel.start) {
                const body = h.text.slice(sel.start, sel.end)
                h.splice(sel.start, sel.end, `[^${n}]`)
                h.atDocEnd(`\n\n[^${n}]: ${body}`)
                return
            }
            const at = sel ? sel.start : (h.blockRange ? h.blockRange.end : 0)
            h.splice(at, at, `[^${n}]`)
            h.atDocEnd(`\n\n[^${n}]: `)
        },

        find: () => h.findPanel(false),
        replace: () => h.findPanel(true),

        source: () => h.toggle('source'),
        focus: () => h.toggle('focus'),
        typewriter: () => h.toggle('typewriter'),
        sidebar: () => h.toggle('sidebar'),
        outline: () => h.toggle('outline'),
        fileTree: () => h.toggle('fileTree'),
        statusbar: () => h.toggle('statusbar'),
        fullscreen: () => h.fullscreen(),
        zoomIn: () => h.zoom(1),
        zoomOut: () => h.zoom(-1),
        zoomReset: () => h.zoom(0),
        'theme-light': () => h.theme('light'),
        'theme-dark': () => h.theme('dark'),
        'theme-newsprint': () => h.theme('newsprint'),
        'theme-minimal': () => h.theme('minimal'),
    }
    return acts
}

/** 目录 = 各标题的纯文本按级别缩进的列表（Typora 插的也是列表，不是占位符） */
export function tocOf(text: string): string {
    const out: string[] = []
    for (const raw of text.split('\n')) {
        const m = /^(#{1,6}) (.*)$/.exec(raw)
        if (!m) continue
        out.push(`${'  '.repeat(m[1].length - 1)}- ${m[2]}`)
    }
    return out.join('\n')
}

/*
 * --------------------------------------------------------------- C 批：文件那半边的规则
 *
 * 落点在文件系统，但**规则本身**是纯的（副本怎么起名、最近列表怎么留、快速打开怎么过滤、
 * 编码表列哪几档、HTML 怎么折成 Markdown），所以逻辑写在这里、能在 Node 里量；
 * main.ts 只负责拿句柄和权限。
 */

/** 重新打开时能选的编码。名字都是 TextDecoder 认的（这台机上量过 gbk/big5 能正确解出汉字） */
export const ENCODINGS: [string, string][] = [
    ['utf-8', 'UTF-8'], ['gbk', '简体中文 (GBK)'], ['big5', '繁体中文 (Big5)'],
    ['shift_jis', '日语 (Shift_JIS)'], ['euc-kr', '韩语 (EUC-KR)'], ['utf-16le', 'UTF-16 LE'],
]

/** 创建副本的名字：`a.md` → `a 副本.md`，占着就往后编号 */
export function nextCopyName(name: string, taken: string[]): string {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 0; ; i++) {
        const cand = `${stem} 副本${i ? ' ' + (i + 1) : ''}${ext}`
        if (!taken.includes(cand)) return cand
    }
}

/** 最近打开：新的排最前、同名去重、最多留 8 条（存的是名字，句柄存不住，见下面的场地事实） */
export function pushRecent(list: string[], name: string, max = 8): string[] {
    return [name, ...list.filter(x => x !== name)].slice(0, max)
}

/** 快速打开的过滤：不分大小写、子串命中即可，最多给 12 条 */
export function filterFiles(files: string[], q: string, max = 12): string[] {
    const k = q.trim().toLowerCase()
    return (k ? files.filter(f => f.toLowerCase().includes(k)) : files).slice(0, max)
}

/**
 * 导入 HTML：把标签折成 Markdown 的粗骨架。只认结构性的那几个标签，
 * 其余一律剥掉 —— 我们要的是"能接着编辑的正文"，不是保真的网页。
 * 实体手工还原（&amp; 放最后，否则 &amp;lt; 会被解两次）。
 */
export function htmlToMd(html: string): string {
    const s = html
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(+n)} `)
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<pre[^>]*>/gi, '\n```\n').replace(/<\/pre>/gi, '\n```\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|table)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * 文章列表的顺序：目录树走的是"进一个目录再列它的文件"，所以同名文章会散在不同位置；
 * 文章列表要的是"一行一篇、按文章名排"。返回的是显示顺序对应的原下标，
 * 因为 data-f 认的是 state.files 里的位置，重排不许把点击接到别的文件上。
 */
export function articleOrder(files: { name: string, path: string }[]): number[] {
    return files.map((f, i) => i)
        .sort((a, b) => files[a].name.localeCompare(files[b].name, 'zh')
            || files[a].path.localeCompare(files[b].path, 'zh'))
}

/** 文章列表里那篇的来路：`notes/a.md` → `notes/`，根目录下的就是空串 */
export function folderOf(path: string): string {
    const i = path.lastIndexOf('/')
    return i < 0 ? '' : path.slice(0, i + 1)
}

/*
 * --------------------------------------------------------- E 批：替换表与页面
 *
 * 智能替换：打字时把几个 ASCII 写法折成排印符号。只做**不会改坏 Markdown 语法**的那几条 ——
 * 直引号折成弯引号看着好，但 `"` 也是属性与定义里的定界符，动它就是在动语法，所以不做。
 */
export interface SubRule {
    id: string
    label: string
    pairs: [string, string][]
}

export const SUBRULES: SubRule[] = [
    { id: 'symbols', label: '符号 (c) (r) (tm) (p)', pairs: [['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['(p)', '¶']] },
    { id: 'dash', label: '破折号 -- 和 ---', pairs: [['---', '—'], ['--', '–']] },
    { id: 'ellipsis', label: '省略号 ...', pairs: [['...', '…']] },
    { id: 'arrows', label: '箭头 -> => <-', pairs: [['->', '→'], ['=>', '⇒'], ['<-', '←']] },
]

/** 按打开的规则做替换；一条都没开就原样返回（不白跑一遍正则） */
export function substitute(text: string, on: string[]): string {
    if (!on.length) return text
    let out = text
    for (const r of SUBRULES) {
        if (!on.includes(r.id)) continue
        for (const [from, to] of r.pairs) out = out.split(from).join(to)
    }
    return out
}

/** 纸张：mm。名字用国际叫法，量的是可打印版面，不是浏览器那套 API */
export const PAPERS: [string, number, number][] = [
    ['A4', 210, 297], ['A5', 148, 210], ['B5', 176, 250], ['Letter', 215.9, 279.4],
]

export interface Page {
    size: string
    margin: [number, number, number, number]
}

/** 生成 @page 那一行。Chrome 的 @page 里不认 var()，所以数值只能现拼进样式串 */
export function pageCss(p: Page): string {
    const paper = PAPERS.find(x => x[0] === p.size)
    const size = paper ? `size: ${paper[1]}mm ${paper[2]}mm; ` : ''
    const [t, r, b, l] = p.margin
    return `@page { ${size}margin: ${t}mm ${r}mm ${b}mm ${l}mm; }`
}
