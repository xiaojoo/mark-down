import { openChunked, editChunked, serializeChunked, blocks, type Chunked, type Block } from '../kernel/parse.ts'
import { renderBlocks, cellSource } from '../render/html.ts'
import { highlightSource } from '../render/source.ts'
import { exportHtml, hasMath, katexSubset } from '../render/export.ts'
import { MENUS, allItems, helpHtml, menuBarHtml, type MenuCtx } from './menu.ts'
import { articleOrder, createActions, filterFiles, folderOf, headings, htmlToMd, insertText, nextCopyName, pageCss, pushRecent, SUBRULES, substitute, toEol, PAPERS, type Host, type Page } from './actions.ts'
import { copyDoc, decodeAs, moveTo, readText, renameDoc as renameHandle, writeBytes, writeText, type DirHandle, type FileHandle } from './files.ts'
import { findMatches, type Hit } from './find.ts'
import { enterAction, insertBlockAt } from './editing.ts'
import { lineMarks } from './gutter.ts'
import type { Node } from '../kernel/node.ts'

/*
 * 浏览器壳。它只做四件事：读文件、把渲染层塞进 #write、把一次块编辑交回
 * editChunked、写盘。**没有任何 Markdown 逻辑在这里** —— 内核那套区间与
 * 标记才是唯一真相，所以同一个内核换 Qt 壳或 Node 壳都不用改。
 *
 * 写盘按能力递减：手里有文件句柄就写回原文件；没有就弹"另存为"；
 * 再没有（file:// 下 File System Access 被禁时）退回浏览器自己的下载，
 * 并在状态栏明说这次没写回原处 —— 不假装写回去了。
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const state = {
    c: null as Chunked | null,
    editing: -1,
    /* 正在编辑的最小单元区间（点列表的一项 / 引用的一段时给）；null = 整块 */
    editRange: null as { start: number, end: number } | null,
    /* 上一次提交时光标在全文里的偏移；点菜单的那一下会先提交、光标跟着没了，
     * "只动一行"那类动作（列表缩进）得靠它知道原来是哪一行 */
    lastCaret: null as number | null,
    sourceAll: false,
    name: '未命名.md',
    handle: null as FileSystemFileHandle | null,
    dir: null as FileSystemDirectoryHandle | null,
    files: [] as { name: string, path: string, dir: FileSystemDirectoryHandle }[],
    lastStart: 0,
    findOpen: false,
    /* 侧栏当前那一页（页签 / 菜单里的大纲、文件目录树 / 跨文件搜，都改这一个） */
    sideTab: 'file' as 'file' | 'toc',
    /* 空段落在源码里没有节点，所以"新块"只能记成一个插入偏移（两次回车时用） */
    insertAt: null as number | null,
    dirty: false,
    savedText: '',
    savedVia: '',
    /* 写盘用的换行符：内存里永远是 \n，只有落地的那一份按这个转（菜单 编辑 › 换行符） */
    eol: (localStorage.getItem('mdkit.eol') ?? 'lf') as 'lf' | 'crlf' | 'cr',
    /* 编辑框要不要让浏览器查拼写（菜单 编辑 › 拼写与语法）；新建的框在 render 末尾统一刷 */
    spell: localStorage.getItem('mdkit.spell') === '1',
    /* 最近打开过的文件名（localStorage 存得住名字，句柄存不住 —— indexedDB 在 file:// 打不开） */
    recents: JSON.parse(localStorage.getItem('mdkit.recent') ?? '[]') as string[],
    /* 开着的文档：一个标签一份缓冲。当前那一份的正文仍以 state.c 为准，切走时才回写 */
    docs: [] as { name: string, handle: FileSystemFileHandle | null, text: string, lastStart: number, dirty: boolean }[],
    docAt: 0,
    /* 侧栏「文件」那一页画成目录树还是平铺的文章列表（菜单 视图 › 文章列表 切） */
    treeFlat: false,
    /* 图片按原尺寸还是铺满正文宽（菜单 编辑 › 图片工具） */
    imgNatural: localStorage.getItem('mdkit.imgNatural') === '1',
    /* 打开的智能替换规则 id（打字提交时应用，见 commit） */
    subs: JSON.parse(localStorage.getItem('mdkit.subs') ?? '[]') as string[],
    /* 纸张与页边距：默认就是 theme.css 里那条 @page（A4，18/16mm） */
    page: JSON.parse(localStorage.getItem('mdkit.page') ?? 'null') as Page | null
        ?? { size: 'A4', margin: [18, 16, 18, 16] },
}

const DEMO = `# mdkit 复刻 Typora 的内核演示

这段是**预览**：\`#\`、\`**\`、\`>\` 这些格式码不露出来，只留下排好版的样子。点进哪一块，那一块换成它的源码，别的一块都不挪；点句子里的一个加粗串，只换那一个串。

> 引用两行的 > 号是标记，预览里连位置都不占
> 这一样能逐字节存回去

> [!NOTE]
> 提示块：这个 [!NOTE] 标记留在源码里，只显示成带色的框

- [ ] 点任一块就就地编辑它的源码
- [x] Esc 或点别处提交，只重算这一块

\`\`\`ts
const 往返 = serialize(parse(原文)) === 原文
\`\`\`

| 类型 | 标记去向 |
| --- | --- |
| setext 下划线 | close |
| 引用 \`>\` | 续行留在正文 |

引用式链接也认得远处的定义：[Typora 的官网][ty]。

[ty]: https://typora.io "标题写在第二行"
`

/* 正在就地编辑的那一层正文；innerHTML 一重建就没它了，所以 render 前先放掉 */
let editingBody: HTMLElement | null = null

/* 插入态的假块：区间是空的，渲染出来就是一个空 textarea */
const EMPTY_BLOCK: Node = { type: 'paragraph', open: '', sep: [], close: '', body: '', children: [] }

function text(): string {
    return state.c?.text ?? ''
}

function render(): void {
    editingBody = null
    const write = $<HTMLDivElement>('write')
    if (!state.c) return
    /*
     * 源码模式不再是一整块 textarea：它和预览走同一套渲染，只是把标记显出来
     * （图二那样：`#`、`>`、`**`、`|` 都在，语法着色也都在）。
     * textarea 里的文字没法分段上色，要做成图里那样只能换实现。
     */
    write.classList.toggle('source', state.sourceAll)
    if (state.sourceAll) {
        /*
         * 整篇源码 = 一个不换行的文本域。试过"走预览那套渲染、把标记显出来"，量出来做不成：
         * 预览为了排版会擦掉行首的 `> `（擦掉的字符回不来），而列表/表格/引用的子块都是块级
         * <div>，一行源码会被拆成三四行 —— 判据是"可见文字 === 源码"当场为 false。
         * 文本域至少保证一个字都不差；要图二那种着色，得在文本域后面再叠一层按行高亮的镜像。
         */
        const t = text()
        /* 结尾那几个换行**不显示**：textarea 里一个结尾的 \n 会凭空多出一行空行，
         * 于是底下比上面多出一整行的间隙（28 → 28+27.2），而且那一行还算进滚动高度 ——
         * 内容其实没超出窗口，也会顶出一条滚动条。提交时按 data-tail 原样接回去
         * （commit 开头那条通用逻辑就吃这个属性，块编辑早就是这么办的）。 */
        const tail = (/\n*$/.exec(t) ?? [''])[0].length
        const shown = t.slice(0, t.length - tail)
        const lines = shown.split('\n').length
        const nums = lineMarks(lines).map(m => `<span class="md-ln" style="--k:${m.k}"><span>${m.n}</span></span>`).join('')
        write.innerHTML = `<div class="md-block md-source-all md-editing">`
            + `<div class="md-src-hl">${highlightSource(shown)}</div>`
            + `<textarea class="md-src" spellcheck="false" wrap="off" data-tail="${tail}" `
            + `rows="${lines}">${escapeHtml(shown)}</textarea>${nums}</div>`
    } else {
        const bs = blocks(state.c)
        if (state.insertAt != null) {
            const at = state.insertAt
            const k = bs.findIndex(b => b.start >= at)
            const pseudo = { node: EMPTY_BLOCK, start: at, end: at }
            if (k < 0) { bs.push(pseudo); state.editing = bs.length - 1 }
            else { bs.splice(k, 0, pseudo); state.editing = k }
        }
        write.innerHTML = renderBlocks(bs, {
            text: text(), editing: state.editing, marks: find.hits, current: find.at,
            editRange: state.editRange ?? undefined,
        })
    }
    renderToc()
    renderStatus()
    paintFind()
    paintCaretLine()
    applySpell()
}

/*
 * 当前行的行号与那道灰带：CSS 算不出光标在哪一行，只能在这儿写。
 * 只在源码模式有意义（号也只在那时发）。两个元素都是绝对定位，不参与排版。
 */
function paintCaretLine(): void {
    const write = $<HTMLDivElement>('write')
    const ed = write.querySelector<HTMLElement>('.md-editing')
    const ta = ed?.querySelector<HTMLTextAreaElement>('.md-src')
    if (!ed || !ta || !state.sourceAll) return
    const k = ta.value.slice(0, ta.selectionStart).split('\n').length - 1
    for (const [cls, txt] of [['md-ln-here', `<span>${k + 1}</span>`], ['md-band', '']] as const) {
        let el = ed.querySelector<HTMLElement>(`:scope > .${cls}`)
        if (!el) { el = document.createElement('span'); el.className = cls; ed.appendChild(el) }
        el.style.setProperty('--k', String(k))
        el.innerHTML = txt            /* 号套一层 span：小字号不能写在外层，否则 1lh 就不是块的行高了 */
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
}

/* 大纲：直接从块树读，标题级别仍从标记反推（见 render/html.ts 的 headingLevel） */
function renderToc(): void {
    if (!state.c) return
    const items = blocks(state.c)
        .map((b, i) => ({ b, i }))
        .filter(x => x.b.node.type === 'heading')
        .map(x => {
            const atx = /^ {0,3}(#{1,6})/.exec(x.b.node.open)
            const lv = atx ? atx[1].length : (/\n {0,3}=/.test(x.b.node.close) ? 1 : 2)
            const label = headingLabel(x.b.node)
            return `<a class="lv${lv}" href="#" data-i="${x.i}">${escapeHtml(label)}</a>`
        }).join('')
    $('toc').innerHTML = items || '<a class="lv1" href="#">（无标题）</a>'
}

function headingLabel(n: { open: string, body: string, children: unknown[], close: string }): string {
    return n.children.length ? String((n as { children: { body: string }[] }).children.map(c => c.body).join(''))
        : n.body
}

/** 词数：中日韩一字算一词，拉丁按连续字母数字算一词（Typora 状态栏就是这个口径） */
const WORD_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]|[A-Za-z0-9_]+/g
function wordCount(s: string): number {
    return (s.match(WORD_RE) ?? []).length
}

const FOLDER_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="none" stroke="currentColor"/></svg>'

/*
 * 折叠侧栏那颗：画的图标，不是 ‹ 这个字符（字符归字体管，换字体就换形，还坐基线上对不齐）。
 * 12×12 和旁边那颗文件夹同尺寸；笔尖朝左 = 把这一列收走，收起来之后 CSS 把它转 180°
 * 变成朝右的"放回来"，图标不许说谎。
 */
const SIDE_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M10.5 2.5 5 8l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'

/* 标签上的关和开：画的，不是 ✕ / + 字符（字符归字体管，换字体换形，还坐基线上对不齐） */
const X_SVG = '<svg class="dt-x" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
const PLUS_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'

/* 目录弹层的开合与"最近使用的目录"清单（清单在 IndexedDB 里，见 dirsDb） */
let dirPopOpen = false
let recents: { name: string, at: number, handle: FileSystemDirectoryHandle }[] = []

function dirPopHtml(): string {
    const list = recents.length
        ? recents.map((d, i) => `<button data-recent="${i}">${FOLDER_SVG}<span>${escapeHtml(d.name)}</span></button>`).join('')
        : '<div class="none">还没有记录</div>'
    return `<div class="sec">最近使用的目录</div>${list}<div class="sec">目录</div>`
        + '<button id="st-open-dir">打开文件夹…</button>'
}

/** 焦点/打字机这两档的开关态就写在 #write 的 class 上，状态栏要跟着亮 */
const writeOn = (cls: string) => document.getElementById('write')?.classList.contains(cls) ?? false

function renderStatus(): void {
    const bs = state.c ? blocks(state.c) : []
    const t = text()
    const diag = `${bs.length} 块 · ${state.c ? state.c.regions.length : 0} 区域 · `
        + `${t.replace(/\s+/g, '').length} 字${state.dirty ? ' · 未保存' : ''}`
        + escapeHtml(state.savedVia ? ' · ' + state.savedVia : '')
    $('status').innerHTML = [
        `<div id="dirpop"${dirPopOpen ? ' class="on"' : ''}>${dirPopHtml()}</div>`,
        '<button id="st-side" aria-label="折叠或展开侧栏" title="折叠 / 展开侧栏（Ctrl+Shift+L）">' + SIDE_SVG + '</button>',
        '<button id="st-dirs" aria-label="目录" title="目录">' + FOLDER_SVG + '</button>',
        `<button id="st-source" aria-pressed="${state.sourceAll}" title="源码模式（Ctrl+/）">&lt;/&gt;</button>`,
        `<button id="st-focus" aria-pressed="${writeOn('focus')}" title="焦点模式">◎</button>`,
        `<button id="st-typewriter" aria-pressed="${writeOn('typewriter')}" title="打字机模式">⌨</button>`,
        '<span class="grow"></span>',
        `<span>${wordCount(t)} 词</span>`,
        `<span class="dim">${diag}</span>`,
    ].join('')
    /* 标签上那颗"未保存"和状态栏那句是同一件事，所以跟着一起刷 ——
     * 只在切标签时刷的话，你正敲着字的那一格明明脏了，标签上却看不出来 */
    if (document.getElementById('doctabs')) renderDoctabs()
}

/*
 * 自绘的悬停气泡。原生 title 那一发是 Chrome 画的：字号、底色、圆角都不归主题管，
 * 深色皮上就是一块灰补丁 —— 他要的是"自己绘画一个"。
 * **写法照旧写 title，由这里当场截走**（他早先在另一个项目里就选了这条：
 * 「全局拦截 title，统一自绘气泡」，理由是新加的控件不会忘了挂）。截走 = 把属性搬到
 * data-tip 上并删掉 title，所以原生那条永远等不到自己的延时（它比这里慢）。
 * 全篇共用一个浮层；触发用委托挂在 document 上，因为 renderStatus 每次重写 innerHTML，
 * 那些按钮全是新节点，逐个绑会全绑在脱离文档的壳子上。
 */
const TIP_DELAY = 350
let tipBox: HTMLElement | null = null
let tipFor: HTMLElement | null = null
let tipTimer = 0

/** 这一发 title 归不归自绘气泡管：置灰的按钮不算（原生 title 在 disabled 上本来就不显示） */
function tipTarget(e: Event): HTMLElement | null {
    /* 选择器要同时认 [title] 和 [data-tip]：第一次悬停就把 title 摘了，
     * 只认 [title] 的话同一颗按钮第二次悬停什么都找不到（第一次有、之后再也没有） */
    const el = (e.target as Element).closest?.('[title],[data-tip]') as HTMLElement | null
    if (!el || (el as HTMLButtonElement).disabled) return null
    const t = el.getAttribute('title')
    if (t) { el.removeAttribute('title'); el.dataset.tip = t }
    return el
}

function tipHide(): void {
    clearTimeout(tipTimer)
    tipFor = null
    tipBox?.classList.remove('on')
}

/** 摆到目标上沿外面，尖角指着目标中心；上面放不下（顶栏那一排）就翻到下面 */
function tipPlace(tip: HTMLElement, r: DOMRect): void {
    const w = tip.offsetWidth, h = tip.offsetHeight
    const x = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2))
    const below = r.top - h - 9 < 6
    tip.style.left = `${Math.round(x)}px`
    tip.style.top = `${Math.round(below ? r.bottom + 9 : r.top - h - 9)}px`
    tip.classList.toggle('below', below)
    /* 尖角跟着目标中心走：气泡被视口夹住时，它指的仍是那颗图标而不是气泡自己的中心 */
    tip.style.setProperty('--arrow', `${Math.round(r.left + r.width / 2 - x)}px`)
}

function wireTips(): void {
    const tip = document.createElement('div')
    tip.id = 'tip'
    document.body.appendChild(tip)
    tipBox = tip
    document.addEventListener('pointerover', e => {
        const el = tipTarget(e)
        /* 同一个目标内部来回（图标和字各是一个节点）不许把延时一次次重置，
         * 否则鼠标在按钮上动一动，气泡就永远出不来 */
        if (el === tipFor) return
        tipHide()
        if (!el) return
        tipFor = el
        tipTimer = setTimeout(() => {
            if (!el.isConnected) { tipHide(); return }
            tip.textContent = el.dataset.tip ?? ''
            tip.classList.add('on')           /* 先显出来才量得到自己的宽高 */
            tipPlace(tip, el.getBoundingClientRect())
        }, TIP_DELAY) as unknown as number
    })
    document.addEventListener('pointerout', () => tipHide())
    /* 点了、滚了、按了键，气泡就该没了：原生 title 也是这个规矩 */
    for (const ev of ['pointerdown', 'keydown', 'wheel'])
        document.addEventListener(ev, () => tipHide(), true)
    addEventListener('scroll', () => tipHide(), true)
}

/**
 * 文档名写在**窗口标题**上（图标右边那个）：独立应用窗口（app.bat 的 --app=）的
 * 标题栏文字取的就是 document.title，所以名字跟着窗口走，不再在页面里占一条。
 * 页面里那条 #title-bar 已经删掉了 —— 同一个名字出现两次，看着像没做完。
 */
function setDocTitle(name: string): void {
    document.title = name
}

function load(src: string, name: string, handle: FileSystemFileHandle | null): void {
    state.c = openChunked(src)
    state.name = name
    state.handle = handle
    if (name && name !== '未命名.md') rememberRecent(name)
    markSaved()
    state.editing = -1
    state.insertAt = null
    state.sourceAll = false
    state.editRange = null
    state.lastCaret = null
    state.lastStart = 0
    state.savedVia = ''
    state.savedText = src
    hist.length = 0
    hist.push({ text: state.c.text, block: 0 })
    histAt = 0
    setDocTitle(name)
    render()
}

/* --------------------------------------------------------------- 编辑回路 */

/*
 * 编辑框属于哪一块 —— 按渲染时写在编辑 div 上的 data-s（源码起点）找，**不按下标**。
 * 原因：待插入的那个空块只在 DOM 里占一个 data-i，内核的 blocks() 里没有它，
 * 两边当场错一位（实测：有了空块之后点最后一块，data-i=9 而内核只有 9 块 [0..8]）。
 */
/** 最后一次编辑的那一块：按源码起点认 —— 待插入的空块会让下标错一位，起点不会 */
function lastBlockNow(): Block | null {
    if (!state.c) return null
    const bs = blocks(state.c)
    return bs.find(b => b.start === state.lastStart) ?? bs[bs.length - 1] ?? null
}

/** 包含这个源码位置的整块（最小单元嵌在块里，靠位置找回去） */
function blockAt(pos: number): Block | null {
    if (!state.c) return null
    const bs = blocks(state.c)
    return bs.find(b => b.start <= pos && pos <= b.end) ?? null
}

function commit(ta: HTMLTextAreaElement): void {
    if (!state.c) return
    /* 尾部那几个空行是渲染时从框里剥出去的（见 renderBlocks 的 data-tail），原样接回去 */
    /*
     * 智能替换只动"这一格刚敲的字"，而且**代码里不动**：`a-->b` 写在代码块里就是要它原样。
     * 提交是唯一的落盘点，所以打字、粘贴、切标签走的都是同一条，不会有第二处偷偷换。
     */
    const inCode = !!ta.closest('.md-code-block, .md-code-inline')
    const val = (inCode ? ta.value : substitute(ta.value, state.subs))
        + '\n'.repeat(Number(ta.dataset.tail ?? 0))
    if (state.sourceAll) {
        /* 源码模式那个框是**整篇**，改动按整篇重解析（这时候按块算区间没有意义） */
        if (val !== text()) { state.c = openChunked(val); commitHist() }
        state.lastCaret = Math.min(val.length, ta.selectionStart)
        render()
        return
    }
    /* 待插入的空块：它没有对应的内核块，而且零宽区间的起点和下一块相同，
     * 不先分出去就会把提交错记到那块头上（实测：抹掉过一条引用定义） */
    if ((ta.closest('.md-block')?.hasAttribute('data-new')) ?? false) {
        const at = state.insertAt ?? text().length
        state.insertAt = null
        state.editing = -1
        state.editRange = null
        if (val.trim() !== '') {
            const s = insertBlockAt(text(), at, val)
            state.c = editChunked(state.c, s.from, s.to, s.ins)
            commitHist()
        }
        render()
        return
    }
    /* 替换区间直接读框自己身上的 data-s / data-e：整块编辑和最小单元编辑走同一条路 */
    const from = Number(ta.dataset.s)
    const to = Number(ta.dataset.e)
    if (!Number.isFinite(from) || !Number.isFinite(to)) { state.editing = -1; render(); return }
    const raw = text().slice(from, to)
    /* 兜底：一个**没敲过字**的空框不许把有内容的一段抹掉。走到这里说明判据之外还有
     * 一条我没找到的路 —— 与其让内容消失，不如原地不动并在状态栏说一句。
     * 真想清空：在里面删一下就有 typed 标记，正常提交。 */
    if (val.trim() === '' && raw.trim() !== '' && !ta.dataset.typed) {
        state.savedVia = '空编辑框没有覆盖这一段（内容保持原样）'
        state.editing = -1
        state.editRange = null
        render()
        return
    }
    if (val !== raw) {
        state.c = editChunked(state.c, from, to, val)
        commitHist()
    }
    /* 框里的位置换算回全文偏移：框覆盖 [from,to)，改完之后那段变成 [from, from+val.length) */
    state.lastCaret = from + Math.min(ta.selectionStart, val.length)
    state.editing = -1
    state.editRange = null
    render()
}

/**
 * 这一块预览时占掉的那一段高度 + 漏在盒子外面的下边距（编辑框据此钉，见 focusBlock）。
 * 用 rect 不用 offsetHeight —— 后者四舍五入成整数，钉下去就差那半像素。
 * 漏出去的那笔（列表最后一项的 4px，.md-list-block 自己 margin:0 又没下内衬）
 * 不加在框高上（那会让这一块自己长高 4px），而是写成框的下边距：
 * 子元素的 margin-bottom 和父块的下边距折叠成同一个，下面每一块就原地不动。
 */
function pinOf(host: HTMLElement): [number, number] {
    const cs = getComputedStyle(host)
    const box = host.getBoundingClientRect()
    const next = host.nextElementSibling as HTMLElement | null
    const flow = next
        ? next.getBoundingClientRect().top - box.top - parseFloat(cs.marginBottom)
        : box.height
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
        + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    return [box.height - pad, Math.max(0, flow - box.height)]
}

/** 屏幕坐标落在哪个最小单元上：文档顺序里后代在后，所以一直覆盖到最后的就是最内层 */
function pointUnit(root: HTMLElement, x: number, y: number): HTMLElement | null {
    let best: HTMLElement | null = null
    for (const e of Array.from(root.querySelectorAll<HTMLElement>('.md-eu'))) {
        const r = e.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = e
    }
    return best
}

/** 点一下要钉住的那几项：预览占的高/漏出去的下边距/行内单元的宽/只替换这一小段的区间 */
interface Pin { h?: number, gap?: number, w?: number, range?: { start: number, end: number }, at?: [number, number] }

function focusBlock(i: number, pin: Pin): void {
    if (!state.c) return
    /* 源码模式是"看不看得到标记"，点块不该把它关掉（以前关了：点一下就跳回预览） */
    state.insertAt = null
    state.editing = i
    state.editRange = pin.range ?? null
    render()
    const ta = $<HTMLTextAreaElement>('write').querySelector<HTMLTextAreaElement>('.md-src')
    /* 记住这一块（按源码起点记）：菜单命令、贴图插入位置都认这个记号 */
    state.lastStart = Number(ta?.closest('.md-block')?.getAttribute('data-s') ?? state.lastStart)
    if (ta) {
        if (ta.classList.contains('md-iu')) {
            /* 行内单元只钉宽：高交给 rows=1 的自然高，那正好是一个 line-height，
             * 而这行本来就至少有一个 line-height 高 ⇒ 点击前后这一行一像素都不动。
             * 宽度取 max(原来那几个字的墨迹宽, 装下整串源码的宽)：源码带 `**` 这些记号，
             * 一般比渲染后宽 —— 只钉成渲染宽就会裁字（他报过"点进去看不见内容"）。
             * 后面的句子会被推右一点，这是显出记号的必然代价，Typora 也一样。 */
            ta.style.width = `${Math.max(pin.w ?? 0, naturalWidth(ta) + 8)}px`
            ta.focus()
            const c = caretAt(ta, pin.at)
            ta.setSelectionRange(c, c)
        } else {
            /* 高度钉成点击前那一块的高度：点一下不许让版面跳。
             * 但**只许往大里钉**：预览把围栏、表格分隔行这些藏掉了，那一块的源码
             * 比预览高，钉死就把内容裁没（实测代码块裁 41px、表格裁 16px —— 他报的"点进去没内容"）。
             * 所以取 max(预览占的高, 装下整段源码需要的高)：常见块（标题/正文/列表）预览更高 ⇒ Δ0；
             * 代码块/表格 ⇒ 只长出被藏起来的那几行。
             * 再写成 min-height：grow() 会把高度收回内容自然高，第一次打字就得塌一截 */
            if (pin.h) {
                /* scrollHeight 是向上取整的，会比真需要多出不到 1px（h3 实测 27.64 → 28）。
                 * 一行至少 19px，所以 1px 的容差盖不住任何真被裁的行，只压掉这点假长高 */
                const need = ta.scrollHeight
                const h = need > pin.h + 1 ? need : pin.h
                ta.style.height = ta.style.minHeight = `${h}px`
                if (pin.gap) ta.style.marginBottom = `${pin.gap}px`
            }
            ta.focus()
            ta.setSelectionRange(ta.value.length, ta.value.length)
        }
        if (window.matchMedia('(prefers-reduced-motion: no-preference)').matches) caretIntoView(ta)
    }
}

/*
 * 点在哪，光标就落在哪。文本域里是**源码**（`**页码**`），点击前屏上是**渲染后**的字
 * （`页码`），两者对不上号，所以按屏幕横向比例换算到字符下标 —— 框宽钉的正是原来那几个字
 * 的宽，比例就是这几个人在句中的位置，落点最多差开一对定界符。
 */
function caretAt(ta: HTMLTextAreaElement, at?: [number, number]): number {
    if (!at || (at[0] === 0 && at[1] === 0)) return ta.value.length
    const r = ta.getBoundingClientRect()
    if (r.width <= 0) return ta.value.length
    const f = Math.max(0, Math.min(1, (at[0] - r.left) / r.width))
    return Math.round(f * ta.value.length)
}

/*
 * 源码那一串在这一行里占多宽。量具必须插在**文本域的亲爹底下**：字号/字重是从父级继承的，
 * 挂在 body 上量 h1 里的加粗串就会量成正文大小（宽少一截，框裁字）。
 * 绝对定位 + visibility:hidden ⇒ 不参与排版，量完就拆，这一行一像素都不动。
 */
function naturalWidth(ta: HTMLTextAreaElement): number {
    const m = document.createElement('span')
    m.className = 'md-measure'
    m.textContent = ta.value
    const host = ta.parentElement ?? document.body
    host.appendChild(m)
    const w = m.getBoundingClientRect().width
    m.remove()
    return w
}

/** 打字打多了再长高；点击那一下的高度差恒为 0。行内单元只随内容变宽 */
function grow(ta: HTMLTextAreaElement): void {
    if (ta.classList.contains('md-iu')) { ta.style.width = `${naturalWidth(ta) + 8}px`; return }
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
}

/*
 * 表格单元格的就地编辑：只把 contenteditable 开在正文那一层（.md-body），
 * 提交时替换的也只是它标的 data-b 区间 —— 两侧的分隔管不归它碰。
 * 区间来自内核的 span()，和块级定位共用同一套机制。
 * 返回 true 表示"这一下真的开始了编辑"（调用方据此决定要不要吃掉默认动作）。
 */
function startCellEdit(cell: HTMLElement, at?: [number, number]): boolean {
    if (!state.c || state.editing >= 0 || !cell.isConnected) return false
    const body = cell.querySelector<HTMLElement>('.md-body')
    if (!body || body.getAttribute('contenteditable') === 'plaintext-only') return false
    body.setAttribute('contenteditable', 'plaintext-only')
    body.dataset.editing = '1'
    editingBody = body
    body.focus()
    const sel = document.getSelection()
    let placed = false
    if (at && sel) {
        /* 默认动作发生在那一层还不可编辑的时候，光标只能自己按屏幕坐标找回去 */
        const r = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null })
            .caretRangeFromPoint?.(at[0], at[1])
        if (r && body.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); placed = true }
    }
    if (!placed && sel) {
        /* 找不到落点（没有坐标、或点在了格子外面）就退回行尾 */
        const r = document.createRange()
        r.selectNodeContents(body)
        r.collapse(false)
        sel.removeAllRanges()
        sel.addRange(r)
    }
    return true
}

function commitCell(): void {
    const body = editingBody
    editingBody = null
    if (!body || !state.c) return
    body.removeAttribute('contenteditable')
    delete body.dataset.editing
    const [cs, ce] = (body.dataset.b ?? '').split(',').map(Number)
    if (Number.isNaN(cs) || Number.isNaN(ce)) { render(); return }
    const val = cellSource(body.innerText)
    if (state.c.text.slice(cs, ce) === val) { render(); return }
    state.c = editChunked(state.c, cs, ce, val)
    commitHist()
    render()
}

/*
 * 打字机模式把正在编辑的块钉到视口中线，那是它的定义。
 * 其余模式**只在块真的露出视口时**才动滚动条 —— 之前无条件居中，
 * 点一下本来就看得见的块，整屏被抽走一截（他报的"点击时滚动条跳动"）。
 * 块比视口还高时两个分支都不成立：它已经占满屏幕，动它只会更看不见。
 */
function caretIntoView(el: HTMLElement): void {
    const scroll = $<HTMLDivElement>('scroll')
    const r = el.getBoundingClientRect(), sr = scroll.getBoundingClientRect()
    if (el.closest('#write.typewriter')) { scroll.scrollTop += r.top - sr.top - sr.height / 2; return }
    let d = 0
    if (r.bottom > sr.bottom && r.top >= sr.top) d = r.bottom - sr.bottom
    else if (r.top < sr.top && r.bottom <= sr.bottom) d = r.top - sr.top
    if (d !== 0) scroll.scrollTop += d
}

/* --------------------------------------------------------------- 目录、文件树、搜索 */

/*
 * 只有拿到目录句柄才能做三件事：把图片写进文档旁边的 assets、列文件树、跨文件搜索。
 * 从 FileSystemFileHandle 拿不到父目录，所以这三件都押在"打开文件夹"那一颗按钮上
 * —— 没拿到就当面说不行，不假装做了。
 */
async function openDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!HAS_FSA) return null
    const w = window as unknown as { showDirectoryPicker: (o: unknown) => Promise<FileSystemDirectoryHandle> }
    return await w.showDirectoryPicker({ mode: 'readwrite', id: 'mdkit-dir' })
}

/*
 * "最近使用的目录"存 IndexedDB 而不是 localStorage：FileSystemDirectoryHandle 能被结构化克隆，
 * 存下句柄下次开页面还能直接续用；localStorage 只留得了名字，点了还得重新授权。
 */
type DirEntry = { name: string, at: number, handle: FileSystemDirectoryHandle }
type Permissible = FileSystemDirectoryHandle & {
    queryPermission?: (d: { mode: string }) => Promise<PermissionState>
}

function dirsDb(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const q = indexedDB.open('mdkit', 1)
        q.onupgradeneeded = () => { q.result.createObjectStore('dirs', { keyPath: 'name' }) }
        q.onsuccess = () => res(q.result)
        q.onerror = () => rej(q.error)
    })
}

async function loadRecents(): Promise<void> {
    if (!HAS_FSA) return
    try {
        const db = await dirsDb()
        const all = await new Promise<DirEntry[]>((res, rej) => {
            const q = db.transaction('dirs').objectStore('dirs').getAll()
            q.onsuccess = () => res(q.result as DirEntry[])
            q.onerror = () => rej(q.error)
        })
        db.close()
        recents = all.sort((a, b) => b.at - a.at).slice(0, 8)
    } catch { recents = [] }
}

async function rememberDir(dir: FileSystemDirectoryHandle): Promise<void> {
    try {
        const db = await dirsDb()
        await new Promise<void>((res, rej) => {
            const tx = db.transaction('dirs', 'readwrite')
            tx.objectStore('dirs').put({ name: dir.name, at: Date.now(), handle: dir })
            tx.oncomplete = () => res()
            tx.onerror = () => rej(tx.error)
        })
        db.close()
        await loadRecents()
    } catch { /* 存不下就算了，不挡这次打开 */ }
}

async function useRecent(i: number): Promise<void> {
    const d = recents[i]
    if (!d) return
    const ask = (d.handle as Permissible).queryPermission
    if (ask && await ask.call(d.handle, { mode: 'readwrite' }) !== 'granted') {
        state.savedVia = `"${d.name}" 要重新授权，请再点一次「打开文件夹」`
        renderStatus()
        return
    }
    state.dir = d.handle
    await renderTree()
    state.savedVia = `已连接目录 ${d.name}`
    renderStatus()
}

const MD_FILE = /\.(md|markdown|mdown|txt)$/i
const TREE_CAP = 400
const SEARCH_FILES = 300

interface TreeFile {
    name: string
    path: string
    dir: FileSystemDirectoryHandle
}

async function walk(dir: FileSystemDirectoryHandle, prefix: string, depth: number, out: TreeFile[]): Promise<void> {
    if (depth > 4 || out.length >= TREE_CAP) return
    /* 这版 TS 的 lib.dom 还没给目录句柄声明 values()，浏览器里是有的 */
    const it = dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
    const items: FileSystemHandle[] = []
    for await (const h of it.values()) items.push(h)
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    for (const h of items) {
        if (out.length >= TREE_CAP || h.name.startsWith('.')) continue
        if (h.kind === 'directory')
            await walk(await dir.getDirectoryHandle(h.name), `${prefix}${h.name}/`, depth + 1, out)
        else if (MD_FILE.test(h.name)) out.push({ name: h.name, path: prefix + h.name, dir })
    }
}

async function openTreeFile(f: TreeFile): Promise<void> {
    const fh = await f.dir.getFileHandle(f.name)
    load(await readText(fh), f.path, await writableHandle(fh))
    await renderTree()
}

/*
 * 侧栏两页：文件 / 大纲（照他给的那张图做成 tab）。一个状态管到底 ——
 * 点页签、菜单里的「大纲」「文件目录树」、跨文件搜出结果，全走这里；
 * 谁都不许自己去 classList.toggle('hide')，那样两处会各说一套（以前就是菜单和标题各切各的）。
 * 切页只是显隐：树和大纲本来就各自渲染好了，不用重算。
 */
function setSideTab(t: 'file' | 'toc'): void {
    state.sideTab = t
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('#tabs button')))
        b.setAttribute('aria-selected', String(b.dataset.tab === t))
    $('tree').classList.toggle('hide', t !== 'file')
    $('hits').classList.toggle('hide', t !== 'file')
    $('toc').classList.toggle('hide', t !== 'toc')
}

async function renderTree(): Promise<void> {
    const box = $<HTMLDivElement>('tree')
    if (!state.dir) { box.innerHTML = '<div class="hint">未打开文件夹</div>'; return }
    const files: TreeFile[] = []
    await walk(state.dir, '', 0, files)
    state.files = files
    const cls = (f: TreeFile) => (f.path === state.name ? ' on' : '')
    /* 平铺那一档按文章名排，来路用小字缀在后面；data-f 仍指 state.files 的原下标 */
    const html = state.treeFlat
        ? articleOrder(files).map(i => {
            const f = files[i], folder = folderOf(f.path)
            return `<a href="#" data-f="${i}" class="${cls(f).trim()}"><span>${escapeHtml(f.name)}</span>`
                + `${folder ? `<i>${escapeHtml(folder)}</i>` : ''}</a>`
        }).join('')
        : files.map((f, i) => `<a href="#" data-f="${i}" class="${cls(f).trim()}">${escapeHtml(f.path)}</a>`).join('')
    box.innerHTML = html || '<div class="hint">这个目录里没有 .md</div>'
}

async function searchFiles(term: string): Promise<void> {
    const box = $<HTMLDivElement>('hits')
    if (!state.dir) { box.innerHTML = '<div class="hint">先打开文件夹才能跨文件搜</div>'; return }
    const q = term.trim()
    if (q === '') { box.innerHTML = ''; return }
    /* 搜出来的是文件，结果就住在「文件」那一页：人在大纲页上也得翻过去，
     * 不然列表悄悄更新了却什么都看不见 */
    setSideTab('file')
    const files = state.files.slice(0, SEARCH_FILES)
    const hits: string[] = []
    for (const f of files) {
        const text = await (await (await f.dir.getFileHandle(f.name)).getFile()).text()
        const i = text.indexOf(q)
        if (i < 0) continue
        const line = text.slice(0, i).split('\n').length
        const at = text.slice(Math.max(0, i - 20), i + q.length + 20).replace(/\n/g, '⏎')
        hits.push(`<a href="#" data-p="${escapeHtml(f.path)}"><b>${escapeHtml(f.path)}</b> `
            + `第 ${line} 行 · ${escapeHtml(at)}</a>`)
        if (hits.length >= 50) break
    }
    box.innerHTML = `<div class="hint">在 ${files.length} 个文件里搜「${escapeHtml(q)}」：${hits.length} 处</div>`
        + hits.join('')
}

/* 粘贴或拖入图片：写进文档旁边的 assets/，再把相对路径插进正文 */
async function savePastedImage(item: DataTransferItem): Promise<void> {
    if (!state.dir) {
        state.savedVia = '粘贴图片要先「打开文件夹」才写得进本地'
        renderStatus()
        return
    }
    const file = item.getAsFile()
    if (!file) return
    const assets = await state.dir.getDirectoryHandle('assets', { create: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
    const fh = await assets.getFileHandle(name, { create: true })
    await writeBytes(fh, file)
    insertBlock(`![图片](assets/${name})`)
    await renderTree()
}

/* 在最后一次编辑的那一块之后插入一个新块 */
function insertBlock(md: string): void {
    if (!state.c) return
    const bs = blocks(state.c)
    const at = lastBlockNow()?.end ?? 0
    const pad = at === 0 || state.c.text[at - 1] === '\n' ? '' : '\n'
    state.c = editChunked(state.c, at, at, `${pad}\n${md}\n`)
    commitHist()
    state.savedVia = '图片已写入 assets/ 并插入引用'
    render()
}

/* --------------------------------------------------------------- 开与存 */

const HAS_FSA = typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'

/* Chromium 的 readwrite 权限这一对还没进 TS 的 lib.dom，按窄接口自己声明 */
type RW = FileSystemFileHandle & {
    queryPermission?: (d: { mode: string }) => Promise<PermissionState>
    requestPermission?: (d: { mode: string }) => Promise<PermissionState>
}

async function writableHandle(h: FileSystemFileHandle): Promise<FileSystemFileHandle | null> {
    const p = h as RW
    if (!p.queryPermission || !p.requestPermission) return h
    if (await p.queryPermission({ mode: 'readwrite' }) === 'granted') return h
    return await p.requestPermission({ mode: 'readwrite' }) === 'granted' ? h : null
}

async function openViaPicker(): Promise<void> {
    if (!HAS_FSA) { $('opener').click(); return }
    const w = window as unknown as { showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]> }
    const [h] = await w.showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt'] } }] })
    load(await readText(h), h.name, await writableHandle(h))
}

/** 唯一的写盘出口：换行符在这里转，别处一律按 \n 存 */
async function writeOut(h: FileSystemFileHandle, out: string): Promise<void> {
    await writeText(h, out, state.eol)
}

/** 另存为：不管之前从哪打开的，都重新要一个目标文件并把句柄换成它 */
async function saveAs(): Promise<void> {
    if (!state.c) return
    const out = serializeChunked(state.c)
    if (HAS_FSA) {
        const w = window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }
        const h = await w.showSaveFilePicker({ suggestedName: state.name })
        await writeOut(h, out)
        state.handle = h
        state.name = h.name
        setDocTitle(h.name)
        state.savedVia = `另存为完成 ${new Date().toLocaleTimeString()}`
    } else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([out], { type: 'text/markdown' }))
        a.download = state.name
        a.click()
        URL.revokeObjectURL(a.href)
        state.savedVia = '这个环境不能写回原文件，已走浏览器下载'
    }
    markSaved()
    renderStatus()
}

async function openDirButton(): Promise<void> {
    if (!HAS_FSA) { state.savedVia = '这个环境没有 File System Access，列不了目录'; renderStatus(); return }
    state.dir = await openDir()
    if (state.dir) await rememberDir(state.dir)
    await renderTree()
    state.savedVia = '已连接目录（图片可落地、可跨文件搜）'
    renderStatus()
}

async function save(): Promise<void> {
    if (!state.c) return
    const out = serializeChunked(state.c)
    if (state.handle) {
        await writeOut(state.handle, out)
        state.savedVia = `写回原文件 ${new Date().toLocaleTimeString()}（${state.eol.toUpperCase()}）`
        markSaved()
        renderStatus()
        return
    }
    if (HAS_FSA) {
        const h = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> })
            .showSaveFilePicker({ suggestedName: state.name })
        await writeText(h, out, state.eol)
        state.handle = h
        state.name = h.name
        state.savedVia = '另存为（句柄已拿到，下次写回原处）'
    } else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([out], { type: 'text/markdown' }))
        a.download = state.name
        a.click()
        URL.revokeObjectURL(a.href)
        state.savedVia = '这个环境不能写回原文件，已走浏览器下载'
    }
    markSaved()
    renderStatus()
}

/*
 * 导出 HTML：正文由同一个渲染器生成，样式整份内联，产出一个自包含文件。
 * 写盘位置和 Typora 一样——就放在 .md 旁边；知道目录句柄才写得到，
 * 否则走下载并明说。
 */
function exportedBody(): string {
    if (!state.c) return ''
    return renderBlocks(blocks(state.c), { text: state.c.text, editing: -1 })
}

async function dirOfDoc(): Promise<FileSystemDirectoryHandle | null> {
    if (!state.dir) return null
    const parts = state.name.split('/').slice(0, -1)
    let d = state.dir
    for (const p of parts) {
        try { d = await d.getDirectoryHandle(p) } catch { return state.dir }
    }
    return d
}

/*
 * 导出里的公式：字体表 1.4 MB base64，**只在导出的那一篇真有公式时**才注入。
 * 平时编辑不背它 —— 让所有人替写公式的人付账是不划算的。
 */
function loadKatexFonts(): Promise<Record<string, string>> {
    const w = window as unknown as { __katexFonts?: Record<string, string> }
    if (w.__katexFonts) return Promise.resolve(w.__katexFonts)
    return new Promise(resolve => {
        const sc = document.createElement('script')
        sc.src = 'katex/fonts.js'
        sc.onload = () => resolve(w.__katexFonts ?? {})
        /* 读不到字体表就留着相对路径：应用里照样显示，换台机器打开导出件会掉形，
         * 但那比导出失败好，而且状态栏会报实际字节数，看得出没内联进去 */
        sc.onerror = () => resolve({})
        document.head.appendChild(sc)
    })
}

async function exportCss(bodyHtml: string): Promise<string> {
    const parts = [pageCss(state.page)]
    if (hasMath(bodyHtml)) parts.push(katexSubset(bodyHtml, await loadKatexFonts()))
    return parts.filter(Boolean).join(String.fromCharCode(10))
}

async function exportHtmlFile(): Promise<void> {
    if (!state.c) return
    const body = exportedBody()
    const html = exportHtml(state.name.replace(/\.(md|markdown|mdown|txt)$/i, ''), body, await exportCss(body))
    const out = state.name.replace(/\.(md|markdown|mdown|txt)$/i, '') + '.html'
    const dir = await dirOfDoc()
    if (dir) {
        const fh = await dir.getFileHandle(out.split('/').pop() as string, { create: true })
        await writeText(fh, html, state.eol)
        state.savedVia = `已导出 ${out}（${html.length} 字符，样式已内联）`
    } else {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        a.download = out.split('/').pop() as string
        a.click()
        URL.revokeObjectURL(a.href)
        state.savedVia = '导出走了浏览器下载（没目录句柄写不回原目录）'
    }
    renderStatus()
}

/* 主题：Typora 是一堆 theme 目录，这里等价物是一组 CSS 自定义属性。
 * 四个名字和中文名在 menu.ts 的「视图 › 主题」里，那是唯一的入口（顶栏那颗下拉框他撤了） */
function applyTheme(name: string): void {
    document.documentElement.setAttribute('data-theme', name)
    try { localStorage.setItem('mdkit-theme', name) } catch { /* 隐身模式下存不住，不影响用 */ }
}

function readHandleFromDrop(item: DataTransferItem): void {
    const anyItem = item as DataTransferItem & {
        kind: string
        webkitGetAsEntry?: () => unknown
        getAsFileSystemHandle?: () => Promise<FileSystemFileHandle | null>
    }
    if (anyItem.getAsFileSystemHandle) {
        void anyItem.getAsFileSystemHandle().then(async h => {
            if (!h) return
            load(await readText(h), h.name, await writableHandle(h))
        })
    }
}

/* --------------------------------------------------------------- 查找 / 替换 */

/*
 * 搜的是源码，命中区间就是内核的字节区间 —— 所以高亮、跳转、替换全走同一套
 * 偏移，替换也一律经 editChunked（历史与逐字节往返都还在）。
 * 只在映射得了偏移的叶子里画 <mark>（渲染器里的 data-plain 那条判据）。
 */
const find = { q: '', repl: '', hits: [] as Hit[], at: -1, replace: false }

function findCount(): string {
    if (!find.q) return ''
    return find.hits.length ? `${find.at + 1} / ${find.hits.length}` : '无匹配'
}

function paintFind(): void {
    $<HTMLElement>('findbox').classList.toggle('hide', !state.findOpen)
    $<HTMLElement>('findbox').classList.toggle('noreplace', !find.replace)
    $<HTMLElement>('fcount').textContent = findCount()
    $<HTMLInputElement>('fq').value = find.q
    $<HTMLInputElement>('fr').value = find.repl
}

function scrollToHit(): void {
    const el = document.querySelector('#write .md-hit-current')
    el?.scrollIntoView({ block: 'center' })
}

function openFind(replace: boolean): void {
    state.findOpen = true
    find.replace = replace
    paintFind()
    const box = $<HTMLInputElement>('fq')
    box.focus()
    box.select()
}

function runFind(): void {
    find.q = $<HTMLInputElement>('fq').value
    find.hits = findMatches(text(), find.q)
    find.at = find.hits.length ? 0 : -1
    render()
}

function stepFind(dir: number): void {
    if (!find.hits.length) { runFind(); return }
    find.at = (find.at + dir + find.hits.length) % find.hits.length
    render()
    scrollToHit()
}

function replaceAt(i: number): void {
    const h = find.hits[i]
    if (!h || !state.c) return
    state.c = editChunked(state.c, h.start, h.end, find.repl)
    commitHist()
}

function doReplaceOne(): void {
    find.repl = $<HTMLInputElement>('fr').value
    replaceAt(find.at)
    runFind()
}

/** 从后往前换：前面的命中区间不会因为后面的替换而位移 */
function doReplaceAll(): void {
    find.repl = $<HTMLInputElement>('fr').value
    for (let i = find.hits.length - 1; i >= 0; i--) replaceAt(i)
    runFind()
}

function closeFind(): void {
    state.findOpen = false
    find.hits = []
    find.at = -1
    render()
}

/**
 * 空行上再敲回车 = 另起一块。
 * 当前这一块先按去掉尾部空行的样子写回源码，然后把编辑焦点交给一个"插入点"——
 * 空段落在 Markdown 里没有节点，只能这么记。
 */
function splitEditing(ta: HTMLTextAreaElement): void {
    if (!state.c) return
    const val = ta.value
    if (state.insertAt != null) {
        const at = state.insertAt
        const s = insertBlockAt(text(), at, val)
        state.c = editChunked(state.c, s.from, s.to, s.ins)
        commitHist()
        state.insertAt = s.from + s.ins.length
        render()
        refocusEdit(ta.value.length - 1)
        return
    }
    /* 只换"这一小段"自己的区间（点列表项时父节点的 `- ` 记号不在里面，不会被动到） */
    const from = Number(ta.dataset.s)
    const to = Number(ta.dataset.e)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return
    const content = val.replace(/\n+$/, '')
    if (content !== text().slice(from, to)) {
        state.c = editChunked(state.c, from, to, content)
        commitHist()
    }
    state.insertAt = to
    state.editRange = null
    render()
    refocusEdit(0)
}

/** 重画之后把焦点还给那个编辑框（新块要能接着打字） */
function refocusEdit(caret: number): void {
    const ta = $<HTMLTextAreaElement>('write').querySelector<HTMLTextAreaElement>('.md-src')
    if (!ta) return
    ta.focus()
    const n = Math.max(0, Math.min(caret, ta.value.length))
    ta.setSelectionRange(n, n)
}

/* --------------------------------------------------------------- 菜单条 */

/*
 * Typora 在 Windows 上就是这一条：文件 / 编辑 / 段落 / 格式 / 视图。
 * 表在 src/app/menu.ts（标签抄它的中文菜单字典，加速键抄官方快捷键页），
 * 这里只负责画和点；动作全在 src/app/actions.ts，那边能在 Node 里量。
 */
const hist: { text: string, block: number }[] = []
let histAt = -1
let openTop = -1
let uiScale = 100

/*
 * 历史栈存的是**已提交**的状态（含当前这一个），histAt 指着当前。
 * 之前写成"改动前压栈、histAt 也指着栈顶"，于是撤销算出 at=-1 直接返回 ——
 * 菜单里的撤销点了没反应，就是这么来的。
 */
function markSaved(): void {
    state.savedText = text()
    state.dirty = false
}

function commitHist(): void {
    if (!state.c) return
    hist.splice(histAt + 1)
    if (hist[histAt]?.text === state.c.text) return
    hist.push({ text: state.c.text, block: state.lastStart })
    if (hist.length > 200) hist.shift()
    histAt = hist.length - 1
    state.dirty = state.c.text !== state.savedText
}

function step(dir: number): void {
    const at = histAt + dir
    if (at < 0 || at >= hist.length) return
    histAt = at
    state.c = openChunked(hist[at].text)
    state.lastStart = hist[at].block
    /* 撤销把整篇换了，开着的编辑框指的是旧偏移：不清掉就留下"有 md-editing、没框"的那块死区 */
    state.editing = -1
    state.editRange = null
    state.lastCaret = null
    state.dirty = hist[at].text !== state.savedText
    render()
}

/*
 * ------------------------------------------------------------- 自绘浮层（问一句再动手）
 *
 * 这个壳里一个原生 confirm / prompt / alert 都没有：原生弹窗的底色、字号、按钮文案都归
 * 操作系统，四套皮它一套都不跟，而且在 --app 窗口里是横在屏幕中间的一坨系统灰。
 * 所以"要问一句"的动作（关闭未保存、重命名、移动到、粘贴兜底）共用这一颗。
 * 一次只开一个：第二颗直接拿现有的那颗当答案关掉它，不留叠层。
 */
interface AskOpts {
    label: string
    /** 要不要输入框（重命名 / 移动到 / 粘贴兜底要，是/否不要） */
    entry?: boolean
    multiline?: boolean
    ok?: string
}

let askOpen: ((v: string | null) => void) | null = null

function askBox(o: AskOpts): Promise<string | null> {
    if (askOpen) { askOpen(null); return Promise.resolve(null) }
    return new Promise<string | null>(resolve => {
        const root = document.createElement('div')
        root.id = 'ask'
        const field = o.entry
            ? (o.multiline
                ? `<textarea class="ask-in" spellcheck="false" rows="6"></textarea>`
                : `<input class="ask-in" type="text" spellcheck="false">`)
            : ''
        root.innerHTML = `<div class="ask-box"><div class="ask-label">${escapeHtml(o.label)}</div>${field}`
            + `<div class="ask-row"><button class="ask-ok">${escapeHtml(o.ok ?? '确定')}</button>`
            + `<button class="ask-no">取消</button></div></div>`
        document.body.appendChild(root)
        const done = (v: string | null) => {
            askOpen = null
            root.remove()
            resolve(v)
        }
        askOpen = done
        const inp = root.querySelector<HTMLElement>('.ask-in')
        ;(inp ?? root.querySelector<HTMLElement>('.ask-ok'))?.focus()
        root.querySelector<HTMLElement>('.ask-ok')!.addEventListener('click', () => {
            done(inp && 'value' in inp ? (inp as HTMLTextAreaElement).value : '')
        })
        root.querySelector<HTMLElement>('.ask-no')!.addEventListener('click', () => done(null))
        root.addEventListener('keydown', e => {
            const k = e as KeyboardEvent
            if (k.key === 'Escape') { k.stopPropagation(); done(null) }
            if (k.key === 'Enter' && !o.multiline) { k.preventDefault(); done(inp && 'value' in inp ? (inp as HTMLTextAreaElement).value : '') }
        })
        /* 点浮层外面 = 取消：和抽屉一个脾气 */
        root.addEventListener('pointerdown', e => { if (e.target === root) done(null) })
    })
}

/* -------------------------------------------------------- A 批：宿主那半边的动作 */

/** 当前开着的编辑框（整块框、最小单元框、表格格都算） */
function openBox(): HTMLTextAreaElement | null {
    return $<HTMLDivElement>('write').querySelector<HTMLTextAreaElement>('textarea.md-src, textarea.md-iu')
}

function selectAllInEditor(): void {
    const box = openBox() ?? enterLastBlock()
    if (!box) { state.savedVia = '没有可全选的块'; renderStatus(); return }
    box.focus()
    box.setSelectionRange(0, box.value.length)
    state.savedVia = `已选中 ${box.value.length} 字`
    renderStatus()
}

/** 没在编辑时，按上一次光标所在的块进编辑，把框交回来（全选、粘贴都要这一步） */
function enterLastBlock(): HTMLTextAreaElement | null {
    const cur = lastBlockNow()
    if (!cur) return null
    const write = $<HTMLDivElement>('write')
    const el = write.querySelector<HTMLElement>(`[data-s="${cur.start}"]`)
    if (!el) return null
    ;(el.querySelector('.md-text') ?? el).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return openBox()
}

/** 剪贴板读不到（file:// 上 clipboard-read 是 denied，量过），就自绘一个框让他 Ctrl+V */
async function pasteFrom(plain: boolean): Promise<void> {
    let t: string | null = null
    try { t = await navigator.clipboard.readText() } catch { t = null }
    if (t !== null) { insertText(host(), t, plain); return }
    const got = await askBox({ label: '这个环境不让我自己读剪贴板：在下面的框里按 Ctrl+V，再点确定', entry: true, multiline: true, ok: '贴进去' })
    if (got === null) return
    insertText(host(), got, plain)
}

function speakIt(t: string): void {
    const s = window.speechSynthesis
    if (!s) { state.savedVia = '这个浏览器没有语音接口'; renderStatus(); return }
    if (s.speaking || s.pending) { s.cancel(); state.savedVia = '停止朗读'; renderStatus(); return }
    if (!t.trim()) { state.savedVia = '没有可朗读的文字'; renderStatus(); return }
    const u = new SpeechSynthesisUtterance(t)
    u.lang = 'zh-CN'
    s.speak(u)
    state.savedVia = `朗读 ${t.length} 字（本机语音 ${s.getVoices().length} 个）`
    renderStatus()
}

/** 每个新建的编辑框都要认这个开关，所以刷在 render 末尾而不是各发各的 */
function applySpell(): void {
    for (const ta of Array.from($<HTMLDivElement>('write').querySelectorAll<HTMLTextAreaElement>('textarea'))) {
        ta.spellcheck = state.spell
    }
}

function toggleSpell(): void {
    state.spell = !state.spell
    localStorage.setItem('mdkit.spell', state.spell ? '1' : '0')
    applySpell()
    state.savedVia = `拼写与语法检查：${state.spell ? '开' : '关'}`
    renderStatus()
}

function setEol(eol: 'lf' | 'crlf' | 'cr'): void {
    state.eol = eol
    localStorage.setItem('mdkit.eol', eol)
    state.savedVia = `换行符 ${eol.toUpperCase()} —— 下一次写盘生效`
    renderStatus()
}

function jumpToHeading(i: number): void {
    const want = headings(text())[i]
    if (!want || !state.c) { state.savedVia = '没有这个标题'; renderStatus(); return }
    const b = blocks(state.c).find(x => x.start <= want.at && want.at <= x.end)
    if (!b) return
    state.lastStart = b.start
    render()
    $<HTMLDivElement>('write').querySelector<HTMLElement>(`[data-s="${b.start}"]`)
        ?.closest<HTMLElement>('.md-block')?.scrollIntoView({ block: 'center' })
    state.savedVia = `跳到「${want.title}」`
    renderStatus()
}

async function closeDoc(): Promise<void> {
    if (state.dirty) {
        const a = await askBox({ label: '这一篇还有未保存的改动，确定关闭？', ok: '关闭（丢弃改动）' })
        if (a === null) return
    }
    load('', '未命名.md', null)
}

async function revertDoc(): Promise<void> {
    if (!state.handle) { state.savedVia = '还没有对应的文件，无从恢复'; renderStatus(); return }
    if (state.dirty) {
        const a = await askBox({ label: '磁盘上的版本会覆盖当前改动，确定？', ok: '读回磁盘' })
        if (a === null) return
    }
    load(await readText(state.handle), state.name, state.handle)
    state.savedVia = '已读回磁盘上的版本'
    renderStatus()
}

/*
 * ------------------------------------------------------- C 批：文件那半边的落点
 *
 * 场地事实（都在这台机上量过）：localStorage 可用，但 indexedDB.open() 永不完成 ——
 * 所以**文件句柄存不住**，"最近打开"只能记名字，回头靠当前目录或让他再选一次。
 * 写盘/改名/移动都要 FileSystemFileHandle 的读写权限，而那必须来自一次真用户手势。
 */
function say(m: string): void { state.savedVia = m; renderStatus() }

/** 最近打开：存 localStorage，去重 + 截到 8 条（规则在 actions.pushRecent，那边能单测） */
function rememberRecent(name: string): void {
    state.recents = pushRecent(state.recents, name)
    localStorage.setItem('mdkit.recent', JSON.stringify(state.recents))
}

/** 目录里/最近列表里按名字找那一个文件 */
function findFile(name: string): TreeFile | undefined {
    return state.files.find(f => f.name === name || f.path === name)
}

async function reopenWithEncoding(enc: string): Promise<void> {
    if (!state.handle) { say('要先有对应的文件，才能按编码重开一次'); return }
    const r = await decodeAs(state.handle, enc)
    if (!r.ok) { say(r.why); return }
    load(r.text, state.name, state.handle)
    say(`按 ${enc} 重开了 ${r.text.length} 字`)
}

async function openRecentAt(i: number): Promise<void> {
    const name = state.recents[i]
    if (!name) return
    const f = findFile(name)
    if (f) { await openTreeFile(f); say(`打开了最近的文件 ${name}`); return }
    say(`「${name}」不在当前目录里 —— 用「打开文件夹」或「打开」再选它一次`)
}

async function quickOpen(): Promise<void> {
    if (!state.files.length) { say('快速打开要先「打开文件夹」'); return }
    const q = await askBox({ label: `快速打开（当前目录 ${state.files.length} 个文件）`, entry: true, ok: '打开' })
    if (q === null) return
    const hit = filterFiles(state.files.map(f => f.name), q)
    if (!hit.length) { say(`没有文件名含「${q}」`); return }
    const f = findFile(hit[0])
    if (f) await openTreeFile(f)
    say(`打开 ${hit[0]}${hit.length > 1 ? `（还有 ${hit.length - 1} 个匹配，再输入窄一点）` : ''}`)
}

async function duplicateDoc(): Promise<void> {
    if (!state.dir || !state.c) { say('创建副本要先「打开文件夹」（得知道往哪个目录写）'); return }
    const r = await copyDoc(state.dir, state.name, serializeChunked(state.c),
        state.files.map(f => f.name), state.eol, nextCopyName)
    await renderTree()
    say(r.ok ? `创建了副本 ${r.at}` : r.why)
}

async function renameDoc(): Promise<void> {
    const h = state.handle
    if (!h) { say('这一篇还没落到文件上，无从改名'); return }
    const to = await askBox({ label: `把「${state.name}」重命名为：`, entry: true, ok: '重命名' })
    if (to === null) return
    const r = await renameHandle(h, to)
    if (!r.ok) { say(r.why); return }
    state.name = r.at
    setDocTitle(r.at)
    void renderTree()
    say(`已重命名为 ${r.at}`)
}

async function moveToDir(): Promise<void> {
    const h = state.handle
    if (!h) { say('这一篇还没落到文件上，无从移动'); return }
    const w = window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
    if (!w.showDirectoryPicker) { say('这个浏览器没有目录选择接口'); return }
    let dir: FileSystemDirectoryHandle
    /* 没有用户手势时选择框根本弹不出来（自动化点的就是这一档）：得说一句，不许静默 */
    try { dir = await w.showDirectoryPicker() } catch { say('目录选择框没开出来（它要一次真点击）'); return }
    const r = await moveTo(h, dir)
    if (!r.ok) { say(r.why); return }
    void renderTree()
    say(`已移动到 ${r.at}`)
}

async function importFile(): Promise<void> {
    const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }
    if (!w.showOpenFilePicker) { say('这个浏览器没有文件选择接口'); return }
    let hs: FileSystemFileHandle[]
    try {
        hs = await w.showOpenFilePicker({ types: [{ description: '可导入的文本', accept: { 'text/html': ['.html', '.htm'], 'text/plain': ['.txt'] } }] })
    } catch { say('文件选择框没开出来（它要一次真点击）'); return }
    const fh = await hs[0].getFile()
    const raw = await fh.text()
    const md = /\.html?$/i.test(fh.name) ? htmlToMd(raw) : raw
    /* 句柄故意不给：导入的是别的格式，保存不该写回那个原文件 */
    load(md, fh.name.replace(/\.html?$/i, '.md'), null)
    state.dirty = true
    say(`导入了 ${fh.name}（${raw.length} → ${md.length} 字），另存为才落盘`)
}

/*
 * --------------------------------------------------------- D 批：标签、文章列表、帮助
 *
 * 一个标签 = 一份文档缓冲。当前那一份的正文仍以 state.c 为准（编辑回路只认那一处），
 * 切走的那一刻才回写 —— 所以切换前必须先把开着的编辑框提交掉，不然最后一个字的改动会丢。
 */
function stashDoc(): void {
    const d = state.docs[state.docAt]
    if (d) {
        d.text = text(); d.name = state.name; d.handle = state.handle
        d.lastStart = state.lastStart; d.dirty = state.dirty
    }
}

/** 正在编辑的那一格先提交（切标签、开帮助、切平铺视图都要这一步，一处 owner） */
function commitIfEditing(): void {
    const open = $<HTMLDivElement>('write').querySelector<HTMLTextAreaElement>('.md-editing .md-src')
    if (open) commit(open)
}

/** 当前那一篇的"未保存"以 state.dirty 为准：缓冲只在切走那一刻才回写，读它会慢一拍 */
function isDirty(i: number): boolean {
    return i === state.docAt ? state.dirty : !!state.docs[i]?.dirty
}

function renderDoctabs(): void {
    const box = $<HTMLElement>('doctabs')
    const tabs = state.docs.map((d, i) =>
        `<button data-doc="${i}" class="dt-tab${i === state.docAt ? ' on' : ''}" title="${escapeHtml(d.name)}">`
        + `<span>${escapeHtml(d.name)}</span>${isDirty(i) ? '<span class="dt-dirty">未保存</span>' : ''}${X_SVG}</button>`).join('')
    box.innerHTML = `<div class="dt-list">${tabs || '<span class="dt-none">没有开着的文档</span>'}</div>`
        + `<button id="doc-new" title="新建标签页">${PLUS_SVG}</button>`
}

function openDocAt(i: number): void {
    if (i === state.docAt || !state.docs[i]) return
    commitIfEditing()
    stashDoc()
    const d = state.docs[i]
    state.docAt = i
    load(d.text, d.name, d.handle)
    state.lastStart = d.lastStart
    state.dirty = d.dirty
    renderDoctabs()
}

function newDocTab(): void {
    commitIfEditing()
    if (!state.docs.length) state.docs = [{ name: state.name, handle: state.handle, text: text(), lastStart: state.lastStart, dirty: state.dirty }]
    else stashDoc()
    state.docs.push({ name: '未命名.md', handle: null, text: '', lastStart: 0, dirty: false })
    state.docAt = state.docs.length - 1
    load('', '未命名.md', null)
    renderDoctabs()
    say('新建了一个标签，原来那一份还在它自己的标签里')
}

async function closeTab(): Promise<void> {
    if (state.dirty) {
        const a = await askBox({ label: '这个标签还有未保存的改动，确定关闭？', ok: '关闭（丢弃改动）' })
        if (a === null) return
    }
    commitIfEditing()
    state.docs.splice(state.docAt, 1)
    if (!state.docs.length) { state.docAt = 0; load('', '未命名.md', null); renderDoctabs(); return }
    state.docAt = Math.min(state.docAt, state.docs.length - 1)
    const d = state.docs[state.docAt]
    load(d.text, d.name, d.handle)
    state.lastStart = d.lastStart
    state.dirty = d.dirty
    renderDoctabs()
}

function toggleArticles(): void {
    commitIfEditing()
    state.treeFlat = !state.treeFlat
    setSideTab('file')                       /* 列表就住在「文件」那一页，人在大纲页上得翻过去 */
    void renderTree()
    say(state.treeFlat ? '侧栏改成文章列表（平铺，一行一篇）' : '侧栏改回目录树')
}

function showHelp(): void {
    if (document.getElementById('help')) return
    const root = document.createElement('div')
    root.id = 'help'
    root.innerHTML = `<div class="hp-box"><button id="hp-x" aria-label="关闭帮助">${X_SVG}</button>`
        + helpHtml(menuCtx()) + '</div>'
    document.body.appendChild(root)
    const close = () => root.remove()
    root.querySelector<HTMLElement>('#hp-x')!.addEventListener('click', close)
    root.addEventListener('pointerdown', e => { if (e.target === root) close() })
    root.addEventListener('keydown', e => {
        if ((e as KeyboardEvent).key === 'Escape') { e.stopPropagation(); close() }
    })
}

/*
 * ------------------------------------------------- E 批：图片、智能替换、页面设置
 */
function applyImageMode(): void {
    document.body.classList.toggle('img-natural', state.imgNatural)
    localStorage.setItem('mdkit.imgNatural', state.imgNatural ? '1' : '0')
}

/** 点当前块里（或全文第一处）那张图，让它换成就地编辑的框 —— 和手点它走同一条路 */
function imageProps(): void {
    const write = $<HTMLDivElement>('write')
    const cur = lastBlockNow()
    const host = cur ? write.querySelector<HTMLElement>(`[data-s="${cur.start}"]`)?.closest('.md-block') : null
    const img = (host ?? write).querySelector<HTMLElement>('.md-image') ?? write.querySelector<HTMLElement>('.md-image')
    if (!img) { say('这一篇里没有图片，无从改属性'); return }
    ;(img.querySelector('.md-text') ?? img).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const box = write.querySelector('textarea')
    say(box ? '图片源码进了编辑框：alt 与 src 直接改' : '图片没进编辑态')
}

function toggleSubstitution(id: string): void {
    state.subs = state.subs.includes(id) ? state.subs.filter(x => x !== id) : [...state.subs, id]
    localStorage.setItem('mdkit.subs', JSON.stringify(state.subs))
    const r = SUBRULES.find(x => x.id === id)
    say(`智能替换「${r?.label ?? id}」${state.subs.includes(id) ? '开' : '关'}（打字提交时生效，代码里不动）`)
}

/** @page 里不认 var()，数值只能现拼一条样式；导出也带同一条，两边不许各说一套 */
function applyPageCss(): void {
    let el = document.getElementById('page-css')
    if (!el) { el = document.createElement('style'); el.id = 'page-css'; document.head.appendChild(el) }
    el.textContent = pageCss(state.page)
    localStorage.setItem('mdkit.page', JSON.stringify(state.page))
}

function pageSetup(): void {
    if (document.getElementById('pagebox')) return
    const p = state.page
    const root = document.createElement('div')
    root.id = 'pagebox'
    const mm = (k: number, label: string) => `<label class="pg-mm">${label}`
        + `<input type="number" min="0" max="80" step="1" data-m="${k}" value="${p.margin[k]}"></label>`
    root.innerHTML = `<div class="pg-box"><button id="pg-x" aria-label="关闭页面设置">${X_SVG}</button>`
        + `<h2>页面设置</h2><div class="pg-lab">纸张</div><div class="pg-sizes">`
        + PAPERS.map(([n]) => `<button data-size="${n}" class="${n === p.size ? 'on' : ''}">${n}</button>`).join('')
        + `</div><div class="pg-lab">页边距（毫米）</div><div class="pg-margins">`
        + mm(0, '上') + mm(1, '右') + mm(2, '下') + mm(3, '左') + '</div>'
        + `<div class="pg-foot"><span class="pg-now"></span><button id="pg-ok">应用</button></div></div>`
    document.body.appendChild(root)
    const now = root.querySelector<HTMLElement>('.pg-now')!
    const paint = () => { now.textContent = pageCss(state.page) }
    paint()
    root.addEventListener('click', e => {
        const t = e.target as Element
        const size = t.closest<HTMLElement>('[data-size]')
        if (size) {
            state.page = { ...state.page, size: size.dataset.size! }
            root.querySelectorAll('[data-size]').forEach(n => n.classList.toggle('on', n === size))
            paint()
            return
        }
        if (t.closest('#pg-x')) { root.remove(); return }
        if (t.closest('#pg-ok')) {
            const m = Array.from(root.querySelectorAll<HTMLInputElement>('[data-m]')).map(i => Number(i.value) || 0)
            state.page = { size: state.page.size, margin: [m[0], m[1], m[2], m[3]] }
            applyPageCss()
            root.remove()
            say(`页面设置：${state.page.size}，边距 ${state.page.margin.join('/')}mm`)
        }
    })
    root.addEventListener('keydown', e => {
        if ((e as KeyboardEvent).key === 'Escape') { e.stopPropagation(); root.remove() }
    })
    root.addEventListener('pointerdown', e => { if (e.target === root) root.remove() })
}

/** 现在处于选中态的档位：图片、换行符、主题、视图那几颗开关都从这一处报 */
function activeActs(): string[] {
    const out = [state.imgNatural ? 'imageNatural' : 'imageFit', `lineEnding:${state.eol}`,
        'theme-' + (document.documentElement.getAttribute('data-theme') ?? 'light')]
    if (state.sourceAll) out.push('source')
    if (state.spell) out.push('spelling')
    if (state.treeFlat) out.push('articles')
    /* 只报判据确定的那几颗：focus / typewriter 就是 #write 上的类；
     * 侧栏、大纲、文件树、状态栏的显隐各住在不同的地方（body 类、网格列宽），
     * 在这里猜着报一个"选中"比不报更容易骗人，所以先不报 */
    for (const n of ['focus', 'typewriter']) if (writeOn(n)) out.push(n)
    return out
}

function buildHost(): Host {
    const cur = lastBlockNow()
    return {
        text: text(),
        blockNode: cur ? cur.node : null,
        blockRange: cur ? { start: cur.start, end: cur.end } : null,
        selection: selectionRange() ?? editorSelection() ?? lastCaretInBlock(),
        renderedHtml: () => exportedBody(),
        /* 动作改完必须把编辑态关掉（和 commit 同一套收尾）：留着 state.editing，
         * render 会给这块刷上 md-editing，而区间已经挪走、框发不出来 ——
         * 那块于是"有 md-editing、没编辑框"，mousedown 一进来就 return，再也点不动了 */
        splice: (f, t, ins) => { state.c = editChunked(state.c!, f, t, ins); commitHist(); state.editing = -1; state.editRange = null; render() },
        replaceAll: t => { state.c = openChunked(t); commitHist(); state.editing = -1; state.editRange = null; render() },
        afterBlock: ins => { if (cur) host().splice(cur.end, cur.end, '\n' + ins) },
        atDocStart: ins => host().splice(0, 0, ins),
        /* 每次都现取 host：上一步 splice 完文本已经变长了，缓存的那份末尾是旧的。
         * 插点取"内容末尾"（尾随换行之前）而不是 t.length：动作给的串自己带了空行分隔，
         * 再排在文档那个尾随换行后面，中间就凭空多出一个空块。 */
        atDocEnd: ins => { const t = text(); const end = t.length - (/\n*$/.exec(t) ?? [''])[0].length
            host().splice(end, end, ins) },
        undo: () => step(-1),
        redo: () => step(1),
        /* 新建和关闭其实是同一件事（丢掉当前这篇、回到空文档），确认也只该有一套 */
        fileNew: () => newDocTab(),
        closeDoc: () => void closeTab(),
        revert: () => void revertDoc(),
        selectAll: () => selectAllInEditor(),
        paste: plain => void pasteFrom(plain),
        speak: t => speakIt(t),
        spellcheck: () => toggleSpell(),
        lineEnding: eol => setEol(eol),
        jumpTo: i => jumpToHeading(i),
        reopenEncoding: enc => void reopenWithEncoding(enc),
        openRecent: name => void openRecentAt(Number(name)),
        quickOpen: () => void quickOpen(),
        duplicate: () => void duplicateDoc(),
        rename: () => void renameDoc(),
        moveToDir: () => void moveToDir(),
        importFile: () => void importFile(),
        newTab: () => newDocTab(),
        switchDocs: name => openDocAt(Number(name)),
        articles: () => toggleArticles(),
        help: () => showHelp(),
        imageMode: m => { state.imgNatural = m === 'natural'; applyImageMode();
            say(m === 'natural' ? '图片按实际大小显示' : '图片铺满正文宽') },
        imageProps: () => imageProps(),
        substitution: id => toggleSubstitution(id),
        pageSetup: () => pageSetup(),
        fileOpen: () => void openViaPicker(),
        fileOpenDir: () => void openDirButton(),
        save: () => void save(),
        saveAs: () => void saveAs(),
        exportHtmlFile: () => void exportHtmlFile(),
        print: () => window.print(),
        newWindow: () => window.open(location.href, '_blank'),
        copy: t => void navigator.clipboard.writeText(t)
            .then(() => { state.savedVia = `已复制 ${t.length} 字符`; renderStatus() })
            .catch(() => { state.savedVia = '剪贴板被这个环境挡住了' }),
        toggle: n => toggleView(n),
        findPanel: replace => openFind(replace),
        fullscreen: () => {
            if (document.fullscreenElement) void document.exitFullscreen()
            else void document.documentElement.requestFullscreen()
        },
        zoom: d => { uiScale = d === 0 ? 100 : Math.min(220, Math.max(60, uiScale + d * 10)); applyZoom() },
        theme: t => applyTheme(t),
    }
}

/* afterBlock / atDocStart 借同一个 host 的 splice；host 每次都从当前状态现取，
 * 缓存一份就会在连续动作里拿着过期的块区间 */
const host = () => buildHost()

/**
 * 选区 → 源码偏移。只在"显示文本与源码逐字符相同"的格子里映射（data-plain），
 * 因为续行上被擦掉的 `>` 会让显示长度和源码长度不一致，硬换算就会改错字节。
 */
function selectionRange(): { start: number, end: number } | null {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    const a = r.startContainer, b = r.endContainer
    if (a.nodeType !== 3 || b.nodeType !== 3) return null
    const ea = (a.parentElement as HTMLElement | null)?.closest<HTMLElement>('.md-text[data-plain]')
    const eb = (b.parentElement as HTMLElement | null)?.closest<HTMLElement>('.md-text[data-plain]')
    if (!ea || !ea.dataset.cs || ea !== eb) return null
    const base = Number(ea.dataset.cs)
    let acc = 0, n = ea.firstChild
    while (n && n !== a) { acc += n.textContent?.length ?? 0; n = n.nextSibling }
    const start = base + acc + r.startOffset
    const end = base + acc + r.endOffset
    if (!(ea.textContent ?? '').length || start >= end) return null
    return { start: Math.min(start, text().length), end: Math.min(end, text().length) }
}

/**
 * 编辑框里的选区/光标：DOM 的 getSelection() 在 textarea 内部拿不到东西（它不属于文档流），
 * 所以从聚焦的那个框自己的 selectionStart 换算回源码偏移。
 * 框里的值就是它 data-s..data-e 那段源码原文（行内单元逐字，块级框只少了尾随空行，见 data-tail），
 * 于是 base + 框内偏移 就是全文偏移。
 */
function editorSelection(): { start: number, end: number } | null {
    const ta = document.activeElement as HTMLTextAreaElement | null
    if (!ta || ta.tagName !== 'TEXTAREA' || !ta.dataset.s) return null
    const base = Number(ta.dataset.s)
    if (!Number.isFinite(base)) return null
    const end = ta.dataset.e ? Number(ta.dataset.e) : base + ta.value.length
    return { start: Math.min(end, base + ta.selectionStart), end: Math.min(end, base + ta.selectionEnd) }
}

/** 上一次提交时的光标，但它必须还落在"当前那块"里，否则宁可不认（认错了会把别的一行改掉） */
function lastCaretInBlock(): { start: number, end: number } | null {
    const c = state.lastCaret
    if (c == null) return null
    const cur = lastBlockNow()
    if (!cur || c < cur.start || c > cur.end) return null
    return { start: c, end: c }
}

function applyZoom(): void {
    $<HTMLElement>('write').style.fontSize = `${uiScale}%`
    state.savedVia = `缩放 ${uiScale}%`
    renderStatus()
}

function toggleView(name: string): void {
    const write = $<HTMLDivElement>('write')
    /* 切模式会整篇重渲染：正在编辑的那一块先提交，不然框里没提交的字跟着 DOM 一起没了 */
    const open = write.querySelector<HTMLTextAreaElement>('.md-editing .md-src')
    if (open) commit(open)
    const on = {
        source: () => { state.sourceAll = !state.sourceAll; return state.sourceAll },
        focus: () => write.classList.toggle('focus'),
        typewriter: () => write.classList.toggle('typewriter'),
        sidebar: () => document.body.classList.toggle('no-side'),
        outline: () => { setSideTab('toc'); return true },
        fileTree: () => {
            setSideTab('file')
            if (!state.dir) void openDirButton()
            return true
        },
        statusbar: () => document.getElementById('status')!.classList.toggle('hide'),
    }[name]
    if (!on) return
    on()
    /* 状态栏那三颗的按下态不用手动同步：render() 会重画 renderStatus */
    render()
}

function renderMenuBar(): void {
    $<HTMLElement>('menubar').innerHTML = menuBarHtml(menuCtx())
}

/** 画菜单条要问的现场（跳到 = 标题清单、以后 最近文件 = 列表，都跟着当前文档走） */
function menuCtx(): MenuCtx {
    return { text: text(), eol: state.eol, recents: state.recents, docAt: state.docAt,
        docs: state.docs.map((d, i) => ({ name: d.name, dirty: isDirty(i) })), subs: state.subs,
        on: activeActs() }
}

/*
 * 打开一个顶层菜单 = 先按现场重画整条，再把 .on 给那一个。
 * 为什么每次开都重画：带 dyn 的那几项（跳到）的内容是文档里的标题，
 * 开机时画一次就永远停在第一篇的标题上 —— 那是个会骗人的菜单。
 * 重画之后手里的旧节点全脱离文档，所以 .on 只能重查再挂。
 */
function openMenu(i: number): void {
    closeMenus()
    openTop = i
    const bar = $<HTMLElement>('menubar')
    bar.innerHTML = menuBarHtml(menuCtx())
    bar.querySelectorAll<HTMLElement>('.mb-top')[i]?.classList.add('on')
}

function closeMenus(): void {
    openTop = -1
    document.querySelectorAll('.mb-top.on').forEach(el => el.classList.remove('on'))
}

function runAction(id: string): void {
    const acts = createActions(host())
    /* 带参数的项（跳到第几个标题、换行符选哪种、最近文件第几个）在 act 里写成 `名字:参数`：
     * 动作表里注册的还是那个名字，参数原样递进去 */
    const [name, arg] = id.split(':')
    const fn = acts[name]
    if (!fn) { state.savedVia = `菜单项 ${id} 没有动作`; renderStatus(); return }
    fn(arg)
}

/* 加速键：表里的 accel 原样解析，不做任何"我猜 Typora 是这样"的补全 */
function accelIndex(): Map<string, string> {
    const out = new Map<string, string>()
    for (const it of allItems()) {
        if (!it.accel || !it.act || it.off) continue
        out.set(it.accel.toLowerCase().replace(/\s+/g, ''), it.act)
    }
    return out
}

function keyId(e: KeyboardEvent): string {
    const k = e.key === ' ' ? 'space' : e.key.length === 1 ? e.key.toLowerCase() : e.key
    return `${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${k}`
        .replace('ctrl+shift+', 'ctrl+shift+')
}

const ACCEL_KEYS = accelIndex()

/** 编辑框聚焦时仍然抢下来的动作（其余一律让给浏览器原生行为） */
const IN_EDITOR = new Set(['indent', 'outdent'])

function wireMenuBar(): void {
    const bar = $<HTMLElement>('menubar')
    bar.addEventListener('click', e => {
        const top = (e.target as Element).closest<HTMLElement>('.mb-top')
        if (top) {
            const i = Number(top.dataset.top)
            const was = openTop === i
            closeMenus()
            if (!was) openMenu(i)
            return
        }
        const item = (e.target as Element).closest<HTMLElement>('.mb-item')
        if (item?.dataset.act) { closeMenus(); runAction(item.dataset.act) }
    })
    bar.addEventListener('mouseover', e => {
        if (openTop < 0) return
        const top = (e.target as Element).closest<HTMLElement>('.mb-top')
        if (!top || Number(top.dataset.top) === openTop) return
        openMenu(Number(top.dataset.top))
    })
    document.addEventListener('mousedown', e => {
        if (!(e.target as Element).closest('#menubar')) closeMenus()
        if (dirPopOpen && !(e.target as Element).closest('#status')) { dirPopOpen = false; renderStatus() }
    })
    window.addEventListener('keydown', e => {
        const k = e as KeyboardEvent
        if (k.key === 'Escape') { closeMenus(); return }
        if (k.altKey) {
            const m = MENUS.find(x => x.hotkey === k.key.toLowerCase())
            if (m) { k.preventDefault(); openMenu(MENUS.indexOf(m)) }
            return
        }
        const id = ACCEL_KEYS.get(keyId(k))
        /* target 未必是元素（事件可以落在 window / document 上），
         * 直接 .matches 会抛 TypeError 把整条加速键链路打断 */
        const t = k.target as HTMLElement | null
        const inEditor = !!t && typeof t.matches === 'function'
            && t.matches('textarea, [contenteditable], input')
        /*
         * 编辑框里默认不抢按键：Ctrl+Z / Ctrl+A / Ctrl+C 那些得留给浏览器，抢了就把
         * 正在敲的那一格的原生行为弄坏了。但缩进/退格天生是"边打字边按"的 ——
         * 光标在列表项里，按了不许没反应（editorSelection 负责把光标位置递进动作里）。
         */
        if (id && (!inEditor || IN_EDITOR.has(id))) {
            k.preventDefault()
            runAction(id)
        }
    })
}

/* --------------------------------------------------------------- 接线 */

function wire(): void {
    const write = $<HTMLDivElement>('write')
    wireTips()

    /*
     * 进入编辑挂在 **mousedown**，光标由我们自己放 —— 挂在 click 上必然慢半拍：
     * 浏览器在 mousedown 的默认动作里就把光标放到点中的位置，而那一刻
     * 这一格还不是 contenteditable、这一块也还没换成 textarea，
     * 于是第一下只改了状态、看不见光标，得再点一下（他报的"标题、有些表格要点两次"）。
     * 顺序：先量新块的钉高 → 提交正在编辑的那一块 → 再换 DOM → 放光标。
     */
    write.addEventListener('mousedown', ev => {
        const k = ev as MouseEvent
        const el = k.target as Element
        if (el.closest('.md-src')) return           /* 已经在框里：让浏览器正常放光标、选词 */
        const host = el.closest('.md-block') as HTMLElement | null
        if (!host || host.classList.contains('md-editing')) return
        const cell = el.closest('.md-tableCell') as HTMLElement | null
        if (cell && el.closest('.md-meta')) return
        /* 提交会整块重渲染：手里的旧节点当场脱离文档，改动还会把后面每一个字节偏移都挪走，
         * 块数一变连"第几块"这个序号都对不上。所以先记下目标在源码里的起点，
         * 提交完按 (起点 + 这次改动的字节差) 找回同一个元素；序号只作最后兜底。 */
        const bs = () => Array.from(write.querySelectorAll<HTMLElement>(':scope > .md-block'))
        const ordBlock = bs().indexOf(host)
        const ordCell = cell ? Array.from(host.querySelectorAll<HTMLElement>('.md-tableCell')).indexOf(cell) : -1
        /* 图一那种粒度：点列表的一项 / 引用里的一段 / 一个加粗串，只换那一小段，
         * 父节点的记号留着。点在记号或内衬上（没有 .md-eu 祖先）就按屏幕坐标找
         * contained 的最内层单元 —— 文档顺序里后代在后，所以后覆盖前就是最内层。 */
        const unit = el.closest<HTMLElement>('.md-eu')
        const ordUnit = unit ? Array.from(host.querySelectorAll<HTMLElement>('.md-eu')).indexOf(unit) : -1
        const prev = write.querySelector<HTMLElement>('.md-editing')
        const len = () => (state.c ? state.c.text.length : 0)
        const oldLen = len()
        const blockStart = Number(host.querySelector('[data-s]')?.getAttribute('data-s') ?? NaN)
        const cellStart = cell ? Number(cell.dataset.s) : NaN
        const unitStart = unit ? Number(unit.dataset.s) : NaN
        const unitEnd = unit ? Number(unit.dataset.e) : NaN
        /* 点别处 = 先提交。focusout 是默认动作，而我下面要 preventDefault 掉它：
         * 不先提交，正在编辑的那一格/那一块的改动就丢了 */
        if (editingBody) commitCell()
        const prevTa = write.querySelector<HTMLTextAreaElement>('.md-editing .md-src')
        if (prevTa) commit(prevTa)
        const delta = len() - oldLen
        const byStart = (x: number, sel: string) => {
            if (!Number.isFinite(x)) return null
            const now = prev && x >= Number(prev.dataset.e) ? x + delta : x
            return write.querySelector<HTMLElement>(`[data-s="${now}"]`)?.closest<HTMLElement>(sel) ?? null
        }
        /* 按区间（起点+终点）找回：光按起点找会抓到**外层**那个 —— 列表项里的 `**粗**`
         * 和它外面那段段落起点相同（都是 66），querySelector 按文档序返回先出现的，
         * 于是段落赢了，点加粗串却换出整段的框（实测）。区间相同才无所谓：那两段字节一样。 */
        const byRange = (a: number, b: number, sel: string) => {
            if (!Number.isFinite(a) || !Number.isFinite(b)) return null
            const d = prev && a >= Number(prev.dataset.e) ? delta : 0
            return write.querySelector<HTMLElement>(`[data-s="${a + d}"][data-e="${b + d}"]`)?.closest<HTMLElement>(sel) ?? null
        }
        const under = k.clientX !== 0 || k.clientY !== 0 ? document.elementFromPoint(k.clientX, k.clientY) : null
        const live = (under?.closest('.md-block') as HTMLElement | null)
            ?? byStart(blockStart, '.md-block') ?? bs()[ordBlock] ?? null
        if (!live) return
        const i = Number(live.dataset.i)
        if (cell) {
            /* 找不到同一个格子就当这一下没发生，绝不拿脱离文档的旧节点去开编辑 ——
             * 那正好是"点了没反应"的症状 */
            const nowCell = (under?.closest('.md-tableCell') as HTMLElement | null)
                ?? byStart(cellStart, '.md-tableCell')
                ?? Array.from(live.querySelectorAll<HTMLElement>('.md-tableCell'))[ordCell] ?? null
            if (nowCell && startCellEdit(nowCell, [k.clientX, k.clientY])) k.preventDefault()
            return
        }
        const nowUnit = unit
            ? ((under?.closest('.md-eu') as HTMLElement | null) ?? byRange(unitStart, unitEnd, '.md-eu')
                ?? Array.from(live.querySelectorAll<HTMLElement>('.md-eu'))[ordUnit] ?? null)
            : (under ? pointUnit(live, k.clientX, k.clientY) : null)
        /* 单元区间要跟着这次提交挪：改动在它后面才不动，在它前面就整体平移 */
        const shift = (x: number) => (prev && x >= Number(prev.dataset.e) ? x + delta : x)
        const range = nowUnit ? { start: Number(nowUnit.dataset.s), end: Number(nowUnit.dataset.e) }
            : unit && Number.isFinite(unitStart) ? { start: shift(unitStart), end: shift(unitEnd) } : undefined
        const hit = nowUnit ?? live
        const [keep, gap] = pinOf(hit)
        k.preventDefault()
        focusBlock(i, {
            h: keep, gap, range, at: [k.clientX, k.clientY],
            w: nowUnit && nowUnit !== live ? nowUnit.getBoundingClientRect().width : undefined,
        })
    })
    /* 状态栏：renderStatus 每次都会重写这块 innerHTML，所以监听挂在容器上 */
    $('status').addEventListener('click', e => {
        const t = e.target as HTMLElement
        /* 折叠侧栏：和「视图 › 切换侧边栏」、Ctrl+Shift+L 共用 body.no-side 这一个状态，
         * 不在这里另存一份开关 */
        if (t.closest('#st-side')) { toggleView('sidebar'); return }
        if (t.closest('#st-dirs')) { dirPopOpen = !dirPopOpen; renderStatus(); return }
        for (const [id, name] of [['st-source', 'source'], ['st-focus', 'focus'], ['st-typewriter', 'typewriter']] as const)
            if (t.closest(`#${id}`)) { dirPopOpen = false; toggleView(name); return }
        if (t.closest('#st-open-dir')) {
            dirPopOpen = false
            void openDirButton().then(() => renderStatus())
            return
        }
        const r = t.closest<HTMLButtonElement>('[data-recent]')
        if (r) { dirPopOpen = false; void useRecent(Number(r.dataset.recent)).then(() => renderStatus()) }
    })
    /* 光标上下走，行号与灰带跟着走：只重画那两个元素，不碰正文 */
    document.addEventListener('selectionchange', () => {
        const a = document.activeElement
        if (a instanceof HTMLTextAreaElement && a.classList.contains('md-src')) paintCaretLine()
    })
    write.addEventListener('focusout', e => {
        const t = e.target as HTMLElement
        /* 已经脱离文档的旧框不再提交：换块时我们在 mousedown 里就提交过一次，
         * 浏览器随后还会补一发 focusout —— 那时旧框身上的 data-s 是**改之前的起点**，
         * 按起点去找要么找错块、要么落到"末尾再插一份"的分支上（这是唯一能把内容写空的通道） */
        if (!t.isConnected) return
        if (t.dataset.editing) { commitCell(); return }
        if (t.tagName !== 'TEXTAREA') return
        commit(t as HTMLTextAreaElement)
    })
    write.addEventListener('keydown', e => {
        const k = e as KeyboardEvent
        const t = document.activeElement as HTMLElement | null
        if (k.key === 'Escape') { t?.blur(); return }
        /* 格子里回车=提交并退出，不许往单元格里塞换行（换行会把行拆坏） */
        if (k.key === 'Enter' && t?.dataset.editing) { k.preventDefault(); t.blur(); return }
        /* 源码框里：普通回车交给 textarea 换行；光标在文末且上一行是空行时，
         * 这一次回车是"另起一块" */
        if (k.key === 'Enter' && !k.shiftKey && t?.classList.contains('md-src')) {
            const ta = t as HTMLTextAreaElement
            if (enterAction(ta.value, ta.selectionStart) === 'split') {
                k.preventDefault()
                splitEditing(ta)
            }
        }
    })
    /* 就地敲字时先别把 caret 弹走，提交在 blur；框随内容长高 */
    write.addEventListener('input', e => {
        const t = e.target as HTMLElement
        if (t.tagName === 'TEXTAREA') { t.dataset.typed = '1'; state.dirty = true; grow(t as HTMLTextAreaElement); paintCaretLine() }
    })

    $('toc').addEventListener('click', e => {
        e.preventDefault()
        const a = e.target as HTMLElement
        const i = Number(a.getAttribute('data-i'))
        if (!Number.isNaN(i)) $<HTMLElement>(`write`).querySelector<HTMLElement>(`.md-block[data-i="${i}"]`)
            ?.scrollIntoView({ block: 'center' })
    })

    $('opener').addEventListener('change', async e => {
        const f = (e.target as HTMLInputElement).files?.[0]
        if (f) load(await f.text(), f.name, null)
    })
    $('tabs').addEventListener('click', e => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('#tabs button')
        if (b?.dataset.tab === 'file' || b?.dataset.tab === 'toc') setSideTab(b.dataset.tab)
    })
    /* 文档标签栏：点标签=切过去，点标签上那颗 ✕=关这个标签，点末尾的 +=开新标签 */
    $('doctabs').addEventListener('click', e => {
        const t = e.target as Element
        const tab = t.closest<HTMLElement>('[data-doc]')
        if (!tab) {
            if (t.closest('#doc-new')) newDocTab()
            return
        }
        const i = Number(tab.dataset.doc)
        if (t.closest('.dt-x')) {
            /* 关当前这一篇要走带确认的那条路；关别的标签只是从列表里摘掉，不动眼前的文档 */
            if (i === state.docAt) { void closeTab(); return }
            commitIfEditing()
            stashDoc()
            state.docs.splice(i, 1)
            if (i < state.docAt) state.docAt--
            renderDoctabs()
            return
        }
        openDocAt(i)
    })
    $('tree').addEventListener('click', e => {
        e.preventDefault()
        const i = Number((e.target as HTMLElement).getAttribute('data-f'))
        const f = state.files[i]
        if (f) void openTreeFile(f)
    })
    $('hits').addEventListener('click', e => {
        e.preventDefault()
        const p = (e.target as HTMLElement).getAttribute('data-p')
        const f = state.files.find(x => x.path === p)
        if (f) void openTreeFile(f)
    })
    $('find').addEventListener('keydown', e => {
        if ((e as KeyboardEvent).key === 'Enter') void searchFiles(($('find') as HTMLInputElement).value)
    })
    document.addEventListener('paste', e => {
        const items = (e as ClipboardEvent).clipboardData?.items
        if (!items) return
        /* DataTransferItemList 不是可迭代的，只能按下标走 */
        for (let i = 0; i < items.length; i++)
            if (items[i].type.startsWith('image/')) void savePastedImage(items[i])
    })
    /* 查找面板：Enter 下一个、Shift+Enter 上一个、Esc 关闭 */
    $('fq').addEventListener('input', () => runFind())
    $('fq').addEventListener('keydown', e => {
        const k = e as KeyboardEvent
        if (k.key === 'Enter') { k.preventDefault(); stepFind(k.shiftKey ? -1 : 1) }
        else if (k.key === 'Escape') closeFind()
    })
    $('fr').addEventListener('input', () => { find.repl = ($('fr') as HTMLInputElement).value })
    $('fr').addEventListener('keydown', e => {
        if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); doReplaceOne() }
    })
    $('fprev').addEventListener('click', () => stepFind(-1))
    $('fnext').addEventListener('click', () => stepFind(1))
    $('fone').addEventListener('click', () => doReplaceOne())
    $('fall').addEventListener('click', () => doReplaceAll())
    $('fx').addEventListener('click', () => closeFind())
    renderMenuBar()
    wireMenuBar()

    /* 加速键全走菜单表（ACCEL_KEYS），这里不再单列一份，免得两处各说各话 */
    window.addEventListener('beforeunload', e => {
        if (state.dirty) e.preventDefault()
    })
    window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging') })
    window.addEventListener('dragleave', () => document.body.classList.remove('dragging'))
    window.addEventListener('drop', e => {
        e.preventDefault()
        document.body.classList.remove('dragging')
        const it = e.dataTransfer?.items?.[0]
        if (!it) return
        if (it.type.startsWith('image/')) void savePastedImage(it)
        else readHandleFromDrop(it)
    })
}

/** 自检口用：收掉一个编辑框并**确实提交**。
 * 真浏览器里 blur 会触发 focusout（提交挂在那上面），但失焦的窗口/无头里 blur 是空操作，
 * 上一轮的编辑框就一直挂着 —— 下一块量到的 dTop 会带上前一块刚长出来的高度（实测 -26.81）。
 * 补一发合成 focusout：提交后旧节点脱离文档，handler 第一句就 return，所以两次也只提一次。 */
function unmount(ta: HTMLTextAreaElement): void {
    ta.blur()
    ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

/*
 * 点一下不许挪版面、也不许把源码裁掉。vitest 里没有布局（jsdom 的 offsetHeight 恒为 0），
 * 这条只能跑在真浏览器：控制台 __mdkit.heightProbe() → **clip 必须全 0**；
 * dH/dTop 在标题/正文/列表/定义这些块上是 0，在被预览藏了行的块上（代码块的围栏、
 * 表格的分隔行、提示块的 [!NOTE] 行）等于藏掉的那点高度 —— 那是"看得见内容"的代价。
 * 它只点击、只提交原样文本，所以量完文档还是原来那份。
 */
function heightProbe(): { i: number; dH: number; dTop: number; dLeft: number; clip: number; restore: number }[] {
    const write = $<HTMLDivElement>('write')
    const px = (n: number) => Math.round(n * 100) / 100
    const at = (el: HTMLElement) => {
        const w = write.getBoundingClientRect(), r = el.getBoundingClientRect()
        return [r.height, r.top - w.top, r.left - w.left]
    }
    const list = () => Array.from(write.querySelectorAll<HTMLElement>(':scope > .md-block'))
    return list().map((_, i) => {
        /* 每轮都重新取节点：blur 提交会整块重渲染，上一轮的引用就成了脱离文档的壳子
         * （脱离后 getBoundingClientRect 全是 0，量出来的差值看着像"矮了一截"） */
        const el = list()[i]
        const [h0, t0, l0] = at(el)
        /* 进入编辑挂在 mousedown 上（见 wire），.click() 那种合成事件不会触发它 */
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        const ed = write.querySelector<HTMLElement>('.md-editing')
        if (!ed) return { i, dH: NaN, dTop: NaN, dLeft: NaN, clip: NaN, restore: NaN }
        const [h1, t1, l1] = at(ed)
        /* clip 必须为 0：钉高只许"不低于装得下整段源码"，否则点进代码块就看不见内容 */
        const ta = ed.querySelector<HTMLTextAreaElement>('.md-src')!
        const clip = ta.scrollHeight - ta.clientHeight
        unmount(ta)
        return { i, dH: px(h1 - h0), dTop: px(t1 - t0), dLeft: px(l1 - l0), clip: px(clip),
            restore: px(at(list()[i])[0] - h0) }
    })
}

/*
 * 自检口：待插入的空块只在 DOM 里占一个 data-i，内核 blocks() 里没有它 ——
 * 谁按"第几块"去找就错一位（他报的"点一下，内容就不见了"就是这么来的）。
 * 现在一律按源码起点找。这条把那个错位钉住：留一个空块，点最后一块，
 * 看框里装的是不是那一块自己的源码。返回 ok:true 才算修住。
 */
function pendingProbe(): { dom: number, kernel: number, box: string, want: string, ok: boolean } {
    const write = $<HTMLDivElement>('write')
    const list = () => Array.from(write.querySelectorAll<HTMLElement>(':scope > .md-block'))
    const bs = blocks(state.c!)
    const last = bs[bs.length - 1]
    state.insertAt = last.end            /* 假装刚在最后一块后面敲了两次回车 */
    state.editing = -1
    render()
    const dom = list()
    const target = dom[dom.length - 2]   /* 倒数第二块 = 最后一块真内容，点它不许拿到空框 */
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const ta = write.querySelector<HTMLTextAreaElement>('.md-editing .md-src')
    const box = ta?.value ?? ''
    const want = text().slice(last.start, last.end).replace(/\n+$/, '')
    state.insertAt = null
    render()
    return { dom: dom.length, kernel: bs.length, box: box.slice(0, 16), want: want.slice(0, 16),
        ok: box === want && dom.length === bs.length + 1 }
}

/*
 * 自检口：最小单元点下去，只换那一小段。
 * 他报的原话是"你这还是一整块啊，要只是单行的加粗的那个显示"，所以这条量的就是
 * ① 框里装的字节 == 那个行内元素的源码（不多不少）② 同一行别的内容还在 DOM 里
 * ③ 点下去段落不高（行内框只有一行高，而那行本来就有一个 line-height）④ 不裁字。
 */
function inlineProbe(): { box: string, src: string, inline: boolean, dParaH: number,
    clipX: number, clipY: number, unitWas: number, boxW: number, kept: boolean }[] {
    const write = $<HTMLDivElement>('write')
    const px = (n: number) => Math.round(n * 100) / 100
    const SEL = '.md-strong, .md-emphasis, .md-delete, .md-code-inline, .md-link, .md-image'
    /* 先只记下"第几个字节开始"，别攒节点：提交会整块重渲染，第一批引用到第二轮就全是
     * 脱离文档的壳子（rect 全 0，dispatch 也不冒泡到 #write），量出来看着像"点不动"。
     * 找回节点用 :is(...) 括起来：选择器列表不加括号时 [data-s] 只跟在最后一项上，
     * 实测七轮量到的都是第一个加粗串（每个框都报 **粗**，就是这么来的）。 */
    /* 表格里的行内元素不算这一条：格子走 .md-body 那个 contenteditable（两侧的分隔管不能被光标碰到），
     * 换成行内文本域会把 `|` 一起吞进框里 —— 那是另一套已经量过的回路 */
    return Array.from(write.querySelectorAll<HTMLElement>(SEL))
        .filter(seed => !seed.closest('.md-tableCell')).map(seed => {
        const el = write.querySelector<HTMLElement>(`:is(${SEL})[data-s="${seed.dataset.s}"]`)
        if (!el) return { box: '<单元渲染没了>', src: '', inline: false, dParaH: NaN, clipX: NaN, clipY: NaN,
            unitWas: NaN, boxW: NaN, kept: false }
        const para = (el.closest('.md-paragraph') ?? el.closest('.md-heading') ?? el) as HTMLElement
        const p0 = para.getBoundingClientRect()
        const u0 = el.getBoundingClientRect()
        /* textContent 不吃 display:none，两侧的 `**` 也算在内：换成文本域后那一小段
         * 由框里的源码顶上，所以整段应当逐字相同 —— 这就是"别的内容没被吞掉" */
        const t0 = para.textContent
        /* 这一段自己显示出来的字（图片只有 ![](src)，alt 藏在 img 属性里不上屏），
         * 换成框之后由框里的源码顶上 —— 两边各自抹掉自己那截再比，才是"别的内容没被吞" */
        const own = el.textContent
        const src = text().slice(Number(el.dataset.s), Number(el.dataset.e))
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        const ta = write.querySelector<HTMLTextAreaElement>('.md-iu')
        if (!ta) return { box: '<没换成行内框>', src, inline: false, dParaH: NaN, clipX: NaN, clipY: NaN,
            unitWas: px(u0.width), boxW: NaN, kept: false }
        const live = (ta.closest('.md-paragraph') ?? ta.closest('.md-heading') ?? ta) as HTMLElement
        const p1 = live.getBoundingClientRect()
        const r = {
            box: ta.value, src, inline: ta.classList.contains('md-iu'),
            dParaH: px(p1.height - p0.height),
            clipX: px(ta.scrollWidth - ta.clientWidth), clipY: px(ta.scrollHeight - ta.clientHeight),
            unitWas: px(u0.width), boxW: px(ta.getBoundingClientRect().width),
            kept: live.textContent.replace(ta.value, '') === t0.replace(own, ''),
        }
        unmount(ta)
        return r
    })
}

/*
 * 源码模式必须"一个字都不差"。这条是为一次失败而留的 ——
 * 我试过用预览那套渲染把标记显出来当源码模式，结果预览会擦掉行首的 `> `（擦掉的回不来），
 * 块级子 div 还会把一行源码拆成三四行，判据当场就是 false。文本域是构造上忠实，
 * 但"忠实"这件事一旦被换实现就会悄悄丢，所以留这条量着。
 */
function sourceProbe(): { lines: number, whole: boolean, nums: number[], caret: number | null } {
    const write = $<HTMLDivElement>('write')
    const was = state.sourceAll
    if (!was) { state.sourceAll = true; render() }
    const ta = write.querySelector<HTMLTextAreaElement>('.md-src')
    const t = text()
    const r = {
        lines: t.split('\n').length,
        /* 忠实判据：框里的字 + 渲染时剥掉的那几个结尾换行 == 整篇源码。
         * （结尾换行不显示，见 render 里那段 data-tail 的注释） */
        whole: !!ta && ta.value + '\n'.repeat(Number(ta.dataset.tail ?? 0)) === t,
        nums: Array.from(write.querySelectorAll<HTMLElement>('.md-ln > span')).map(e => Number(e.textContent)),
        caret: ta ? ta.value.slice(0, ta.selectionStart).split('\n').length - 1 : null,
    }
    if (!was) { state.sourceAll = false; render() }
    return r
}

/*
 * 自检口：悬停那一发到底是不是自绘的，能不能连着第二次悬停还有。
 * 判据四条：① 停上去之后元素身上的 title 属性必须已经没了（还在 = Chrome 会画它自己那一发）
 * ② #tip 显出来且文字就是原来那句 ③ 移开就收 ④ 同一颗再停一次，还得出来
 * （第④条是为一个真 bug 留的：选择器只认 [title] 时，摘走之后再悬停就再也找不到目标）。
 */
async function tipProbe(id: string): Promise<{ native: string | null, shown: boolean, text: string,
    out: boolean, again: boolean, moved: boolean, restored: boolean }> {
    const el = $<HTMLElement>(id)
    const native0 = el.getAttribute('title')
    const hover = async () => {
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
        await new Promise(r => setTimeout(r, TIP_DELAY + 120))
        return !!tipBox?.classList.contains('on')
    }
    const shown = await hover()
    const r = { native: el.getAttribute('title'), shown, text: tipBox?.textContent ?? '',
        out: false, again: false, moved: (tipBox?.getBoundingClientRect().left ?? 0) !== 0 }
    el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    r.out = !tipBox?.classList.contains('on')
    r.again = await hover()
    el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    /* 探针自己把属性截走了，得原样还回去，否则下一次真悬停就没词了 */
    if (native0) el.setAttribute('title', native0)
    delete el.dataset.tip
    return { ...r, native: native0, restored: el.getAttribute('title') === native0 }
}

/*
 * 自检口：屏上同时开着的弹层数 —— 目录弹层 + 顶栏菜单，两个方向各走一遍，**任何一步都不许到 2**。
 * 他报的"弹框和菜单重叠、多一条边框"就是这个数到过 2：两块面板各有各的 1px 边框，
 * 叠在一起交界处就露两条线。
 */
function popupProbe(): { dirsFirst: number[], menusFirst: number[], max: number } {
    const hit = (el: Element | null) => {
        for (const t of ['mousedown', 'click'] as const) el?.dispatchEvent(new MouseEvent(t, { bubbles: true }))
    }
    const n = () => (document.querySelector('#dirpop.on') ? 1 : 0) + document.querySelectorAll('.mb-top.on').length
    const dirs = () => document.querySelector('#st-dirs')
    const menu = (i: number) => document.querySelectorAll('.mb-top')[i]
    const close = () => hit(document.body)
    const dirsFirst: number[] = []
    close(); hit(dirs()); dirsFirst.push(n()); hit(menu(4)); dirsFirst.push(n())
    const menusFirst: number[] = []
    close(); hit(menu(0)); menusFirst.push(n()); hit(dirs()); menusFirst.push(n())
    close()
    return { dirsFirst, menusFirst, max: Math.max(...dirsFirst, ...menusFirst) }
}

/*
 * 真句柄探针：navigator.storage.getDirectory() 不要用户手势就能拿到一个**真的**
 * FileSystemDirectoryHandle（Chrome 的 origin 私有存储，落在磁盘上），所以这三条写盘函数
 * 能跑在浏览器自己的实现上，而不是只跑在 Node 的替身里。
 * 证不到的那一层写明白：这是沙箱目录，不是用户选的那个目录；权限授予与原生弹框仍然没碰。
 */
async function fsProbe(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    if (!navigator.storage?.getDirectory) { return { supported: false } }
    const dir = await navigator.storage.getDirectory()
    const asFile = (h: FileSystemFileHandle): FileHandle => h as unknown as FileHandle
    const asDir = (h: FileSystemDirectoryHandle): DirHandle => h as unknown as DirHandle
    const text = '# 甲' + String.fromCharCode(10) + '带公式 $x^2$' + String.fromCharCode(10)
    /* 1) 写与读回：换行符按选定的档落地 */
    const h = asFile(await dir.getFileHandle('probe.md', { create: true }))
    await writeText(h, text, 'crlf')
    out.written = (await readText(h)) === text.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10))
    /* 2) 创建副本：走的是应用里那一颗 copyDoc */
    const r = await copyDoc(asDir(dir), 'probe.md', text, ['probe.md'], 'lf', nextCopyName)
    out.copy = r
    out.copyBytes = r.ok ? await readText(asFile(await dir.getFileHandle(r.at))) === text : false
    /* 3) 改名与移动：先看这个实现有没有 move() */
    out.hasMove = typeof (h as unknown as { move?: unknown }).move === 'function'
    if (out.hasMove) {
        const rn = await renameHandle(h, 'probe2.md')
        out.rename = rn
        out.goneAfterRename = await dir.getFileHandle('probe.md').then(() => '还在', () => '没了')
        const sub = asDir(await dir.getDirectoryHandle('sub', { create: true }))
        out.moveTo = await moveTo(asFile(await dir.getFileHandle('probe2.md')), sub)
        out.inSub = await sub.getFileHandle('probe2.md').then(() => '在', () => '不在')
    }
    /* 4) 按编码重读：写一份 GBK 字节进去，再解回来 */
    const g = asFile(await dir.getFileHandle('gbk.md', { create: true }))
    await writeBytes(g, new Uint8Array([0xCE, 0xD2, 0xB5, 0xC4]).buffer)
    out.gbk = await decodeAs(g, 'gbk')
    out.bogus = (await decodeAs(g, '不是编码')).ok
    return out
}

/* 自检口：给 --tool-test 之外的浏览器里也能一把量往返 */
;(window as unknown as Record<string, unknown>).__mdkit = {
    load,
    doc: () => state.c,
    blocks: () => (state.c ? blocks(state.c) : []),
    serialize: () => (state.c ? serializeChunked(state.c) : ''),
    edit: (f: number, t: number, ins: string) => { state.c = editChunked(state.c!, f, t, ins); render() },
    text: () => text(),
    demo: DEMO,
    /* 探针走和真导出同一条拼装路（含公式字体子集），不然量出来的那份不是用户拿到的那份 */
    exportHtml: async (title = 'mdkit') => {
        const body = exportedBody()
        return exportHtml(title, body, await exportCss(body))
    },
    exportSize: async () => (await exportHtml('t', exportedBody(), await exportCss(exportedBody()))).length,

    setTheme: applyTheme,
    hasDir: () => !!state.dir,
    heightProbe,
    inlineProbe,
    popupProbe,
    tipProbe,
    pendingProbe,
    sourceProbe,
    fsProbe,
}

wire()
setSideTab(state.sideTab)        /* 页签的显隐以 state 为准，不让 index.html 里那份 class 单独说话 */
load(DEMO, '演示文档.md', null)
state.docs = [{ name: '演示文档.md', handle: null, text: DEMO, lastStart: 0, dirty: false }]
renderDoctabs()
applyImageMode()
applyPageCss()
void renderTree()
void loadRecents().then(() => renderStatus())
applyTheme((() => { try { return localStorage.getItem('mdkit-theme') || 'light' } catch { return 'light' } })())
