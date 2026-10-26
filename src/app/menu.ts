/*
 * 菜单表：照 Typora Windows 版抄的**形状**。
 *
 * 标签取自 Typora 自带的中文菜单字典（locales/zh-Hans.lproj/Menu.json，295 条，
 * 顺序即模板顺序）；加速键取自官方快捷键页（support.typora.io/Shortcut-Keys/）。
 * 它的菜单模板在加密的 atom.js 里，我不解密，所以查不到出处的加速键一律留空 ——
 * 下面 ACCELS_WITH_SOURCE 那条白名单就是这条规矩的门禁。
 *
 * off: true 的项是"Typora 有、我们还没有对应能力"的，一律灰着列出来（不删，
 * 也不假装能用）；它们必须同时出现在 NOT_DONE 里，见 test/menu.test.ts。
 */
import { ENCODINGS, SUBRULES, headings } from './actions.ts'

export interface MenuItem {
    label: string
    act?: string
    accel?: string
    off?: boolean
    /** 灰着的原因；不写就用那句通用的"Typora 有、这个版本还没做" */
    why?: string
    sep?: boolean
    sub?: MenuItem[]
    /** 内容随现场变的子菜单（跳到 = 标题清单），每次打开菜单条重画一次 */
    dyn?: (c: MenuCtx) => MenuItem[]
}

export interface TopMenu {
    label: string
    hotkey: string
    items: MenuItem[]
}

/** 画菜单条时要问的现场：文档文本、当前换行符、最近打开过的文件、开着的标签 */
export interface MenuCtx {
    text: string
    eol: 'lf' | 'crlf' | 'cr'
    recents: string[]
    docs: { name: string, dirty: boolean }[]
    docAt: number
    subs: string[]
    /** 状态类动作现在选中的是哪个档（图片工具、换行符、主题、视图那些开关） */
    on: string[]
}

export const DEFAULT_CTX: MenuCtx = { text: '', eol: 'lf', recents: [], docs: [], docAt: 0, subs: [], on: [] }

/*
 * 灰着的两类，分得清才有意义：
 * ① 这一批还没做（后面几批会从这里划掉）；
 * ② 这个场地（零服务端 + 浏览器 + file://）根本没有对应接口，做到哪都不会有 ——
 *    那几项在表里带 why，鼠标停上去说的是"接口没有"，不是"我没做"。
 */
export const NOT_DONE = [
    'openLocation',
    'devtools', 'alwaysOnTop',
] as const

/** 只在官方快捷键页上见到过的组合；不在表里的一律不许写进 accel */
export const ACCELS_WITH_SOURCE = new Set([
    'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+O', 'Ctrl+P', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+Shift+T', 'Ctrl+,',
    'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+F', 'Ctrl+H', 'Ctrl+T', 'Ctrl+0',
    'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6',
    'Ctrl+Shift+Q', 'Ctrl+Shift+K', 'Ctrl+Shift+M', 'Ctrl+Shift+[', 'Ctrl+Shift+]',
    'Ctrl+[', 'Ctrl+]', 'Ctrl+/', 'F8', 'F9', 'F11',
    'Ctrl+B', 'Ctrl+I', 'Ctrl+U', 'Ctrl+K', 'Ctrl+Shift+I', 'Ctrl+Shift+`', 'Alt+Shift+5', 'Ctrl+\\',
    'Ctrl+Shift+L', 'Ctrl+Shift+O',
])

export const MENUS: TopMenu[] = [
    {
        label: '文件(F)', hotkey: 'f',
        items: [
            { label: '新建', act: 'new', accel: 'Ctrl+N' },
            { label: '新建窗口', act: 'newWindow', accel: 'Ctrl+Shift+N' },
            { label: '打开', act: 'open', accel: 'Ctrl+O' },
            { label: '打开文件夹', act: 'openDir', accel: 'Ctrl+Shift+O' },
            /* 编码表就是 actions.ENCODINGS 那一行，两边不会各说一套 */
            { label: '选择编码重新打开', sub: ENCODINGS.map(([code, label]) => ({ label, act: `reopenWithEncoding:${code}` })) },
            { label: '打开最近文件', dyn: c => c.recents.length
                ? c.recents.map((n, i) => ({ label: n, act: `openRecent:${i}` }))
                : [{ label: '（还没有记录）', off: true }] },
            /* 不给 Ctrl+P：那个键 Typora 同时派给了打印，我们照抄下来就是一条撞死的加速键 */
            { label: '快速打开', act: 'quickOpen' },
            { label: '打开文件位置', off: true, act: 'openLocation', why: '浏览器不允许网页去开资源管理器' },
            { label: '关闭', act: 'close', accel: 'Ctrl+Shift+T' },
            { label: '保存', act: 'save', accel: 'Ctrl+S' },
            { label: '另存为', act: 'saveAs', accel: 'Ctrl+Shift+S' },
            { label: '创建副本', act: 'duplicate' },
            { label: '重新命名', act: 'rename' },
            { label: '移动到', act: 'moveTo' },
            { label: '恢复到', act: 'revertTo', sep: true },
            { label: '导入', act: 'import' },
            { label: '导出', act: 'exportHtml' },
            { label: '页面设置', act: 'pageSetup' },
            { label: '打印', act: 'print', accel: 'Ctrl+P' },
        ],
    },
    {
        label: '编辑(E)', hotkey: 'e',
        items: [
            { label: '撤销', act: 'undo', accel: 'Ctrl+Z' },
            { label: '重做', act: 'redo', accel: 'Ctrl+Shift+Z', sep: true },
            { label: '剪切', act: 'cut' },
            { label: '复制', act: 'copy' },
            { label: '粘贴', act: 'paste' },
            { label: '复制为 Markdown', act: 'copyMarkdown' },
            { label: '复制为 HTML 代码', act: 'copyHtml' },
            { label: '无格式粘贴', act: 'pastePlain' },
            { label: '全选', act: 'selectAll', accel: 'Ctrl+A', sep: true },
            { label: '查找', act: 'find', accel: 'Ctrl+F' },
            { label: '查找与替换', act: 'replace', accel: 'Ctrl+H' },
            { label: '拼写与语法', act: 'spelling', sep: true },
            { label: '替换', dyn: c => SUBRULES.map(r => ({
                label: `${c.subs.includes(r.id) ? '● ' : ''}${r.label}`, act: `substitution:${r.id}` })) },
            { label: '语音', act: 'speech' },
            { label: '跳到', dyn: c => {
                const hs = headings(c.text)
                return hs.length
                    ? hs.map((x, i) => ({ label: `${'  '.repeat(x.level - 1)}${x.title}`, act: `jumpTo:${i}` }))
                    : [{ label: '（这篇还没有标题）', off: true }]
            } },
            /* 数学工具本身能开（子菜单是真的），里面两条还灰着 —— 渲染等 KaTeX 的体积决定 */
            { label: '数学工具', sub: [{ label: '行内公式', act: 'inlineMath' }, { label: '数学块', act: 'mathBlock' }] },
            { label: '图片工具', sub: [
                { label: '实际大小', act: 'imageNatural' },
                { label: '宽度铺满', act: 'imageFit' },
                { label: '图片属性', act: 'imageProps' },
            ] },
            { label: '换行符', sub: [
                { label: 'Windows (CRLF)', act: 'lineEnding:crlf' },
                { label: 'Unix / macOS (LF)', act: 'lineEnding:lf' },
                { label: '旧 Mac (CR)', act: 'lineEnding:cr' },
            ] },
        ],
    },
    {
        label: '段落(P)', hotkey: 'p',
        items: [
            { label: '一阶标题', act: 'h1', accel: 'Ctrl+1' },
            { label: '二阶标题', act: 'h2', accel: 'Ctrl+2' },
            { label: '三阶标题', act: 'h3', accel: 'Ctrl+3' },
            { label: '四阶标题', act: 'h4', accel: 'Ctrl+4' },
            { label: '五阶标题', act: 'h5', accel: 'Ctrl+5' },
            { label: '六阶标题', act: 'h6', accel: 'Ctrl+6' },
            { label: '普通文本', act: 'paragraph', accel: 'Ctrl+0', sep: true },
            { label: '表格', act: 'table', accel: 'Ctrl+T' },
            { label: '代码块', act: 'codeFence', accel: 'Ctrl+Shift+K' },
            { label: '数学块', act: 'mathBlock', accel: 'Ctrl+Shift+M' },
            { label: '引用', act: 'quote', accel: 'Ctrl+Shift+Q' },
            { label: '有序列表', act: 'ol', accel: 'Ctrl+Shift+[' },
            { label: '无序列表', act: 'ul', accel: 'Ctrl+Shift+]' },
            { label: '任务列表', act: 'task' },
            { label: '列表缩进', act: 'indent', accel: 'Ctrl+[', sep: true },
            { label: '列表退格', act: 'outdent', accel: 'Ctrl+]' },
            { label: '链接引用', act: 'linkReference' },
            { label: '脚注', act: 'footnotes' },
            { label: '水平线', act: 'hr' },
            { label: '目录', act: 'toc' },
            { label: 'YAML Front Matter', act: 'yaml' },
        ],
    },
    {
        label: '格式(O)', hotkey: 'o',
        items: [
            { label: '粗体', act: 'strong', accel: 'Ctrl+B' },
            { label: '斜体', act: 'emphasis', accel: 'Ctrl+I' },
            { label: '下划线', act: 'underline', accel: 'Ctrl+U' },
            { label: '代码', act: 'code', accel: 'Ctrl+Shift+`' },
            { label: '行内公式', act: 'inlineMath' },
            { label: '删除线', act: 'strike', accel: 'Alt+Shift+5' },
            { label: '高亮', act: 'highlight' },
            { label: '上标', act: 'superscript' },
            { label: '下标', act: 'subscript' },
            { label: '注释', act: 'comment' },
            { label: '超链接', act: 'link', accel: 'Ctrl+K' },
            { label: '图片', act: 'image', accel: 'Ctrl+Shift+I', sep: true },
            { label: '清除格式', act: 'clearFormat', accel: 'Ctrl+\\' },
        ],
    },
    {
        label: '视图(V)', hotkey: 'v',
        items: [
            { label: '新建标签页', act: 'newTab' },
            { label: '源代码模式', act: 'source', accel: 'Ctrl+/' },
            { label: '焦点模式', act: 'focus', accel: 'F8' },
            { label: '打字机模式', act: 'typewriter', accel: 'F9', sep: true },
            { label: '切换侧边栏', act: 'sidebar', accel: 'Ctrl+Shift+L' },
            { label: '大纲', act: 'outline' },
            { label: '文件目录树', act: 'fileTree' },
            { label: '文章列表', act: 'articles' },
            { label: '总是置顶', off: true, act: 'alwaysOnTop', why: '网页管不了窗口层级，浏览器没有这个接口' },
            { label: '全屏', act: 'fullscreen', accel: 'F11', sep: true },
            { label: '显示状态栏', act: 'statusbar' },
            { label: '实际大小', act: 'zoomReset', sep: true },
            { label: '放大', act: 'zoomIn' },
            { label: '缩小', act: 'zoomOut' },
            { label: '主题', sub: [
                { label: '默认', act: 'theme-light' },
                { label: '深色', act: 'theme-dark' },
                { label: '仿书', act: 'theme-newsprint' },
                { label: '极简', act: 'theme-minimal' },
            ] },
            { label: '切换开发者工具', off: true, act: 'devtools', why: '开发者工具归浏览器管，页面点不开' },
            { label: '在已打开文档间切换', dyn: c => c.docs.length > 1
                ? c.docs.map((d, i) => ({ label: `${i === c.docAt ? '● ' : ''}${d.name}${d.dirty ? ' ·未保存' : ''}`, act: `switchDocs:${i}` }))
                : [{ label: '（只开了一个文档）', off: true }], sep: true },
            { label: '帮助', act: 'help' },
        ],
    },
]

/** 摊平所有可点项（含子菜单），给门禁和快捷键表用 */
export function allItems(): MenuItem[] {
    const out: MenuItem[] = []
    for (const m of MENUS) {
        for (const it of m.items) {
            out.push(it)
            if (it.sub) out.push(...it.sub)
        }
    }
    return out
}

/** 摊平成"屏上会画出来的那些项"：dyn 的那几项按现场展开（默认现场 = 空文档） */
export function flatItems(ctx: MenuCtx = DEFAULT_CTX): MenuItem[] {
    const out: MenuItem[] = []
    for (const m of MENUS) {
        for (const it of m.items) {
            out.push(it)
            if (it.sub) out.push(...it.sub)
            if (it.dyn) out.push(...it.dyn(ctx))
        }
    }
    return out
}

const esc = (s: string): string =>
    s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

/*
 * 下级箭头是**画出来的图标**，不是字符。
 * 字符（› / > / ❯）全都归字体管：三家字体的 › 宽窄、粗细、高低各不相同，
 * 换皮或换系统就歪，而且它坐在基线上 —— 和 14px 的标签对不齐。
 * 一条 path、stroke=currentColor，于是宽度/颜色/对齐都由我们定，反白时跟着字走。
 */
const CHEVRON = '<svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M5.5 2.5 11 8l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>'

function itemHtml(it: MenuItem, ctx: MenuCtx): string {
    /* 分隔线是"在这一项之前画一道"，不是"把这一项换成一道" —— 早先写成 return
     * 分隔线，于是 重做 / 全选 / 普通文本 这些带 sep 的项整个从菜单上消失了，
     * 而数据表门禁照样全绿（它查的是表，不是渲染结果） */
    const bar = it.sep ? '<div class="mb-sep"></div>' : ''
    /* 灰的排最后：off 的判据比选中的重，一条灰行不该同时带选中色 */
    const cls = it.off ? 'mb-item off'
        : (it.act && ctx.on.includes(it.act) ? 'mb-item sel' : 'mb-item')
    const sub = it.dyn ? it.dyn(ctx) : it.sub
    /* 这里照旧写原生 title：屏上不会露出来 —— main.ts 的 wireTips 在 pointerover 上
     * 把它截走换成自绘气泡（底色字号跟主题）。写 title 而不是写 data-tip，是为了
     * 新加的控件忘了接也照样有提示，不会静默变成"没提示" */
    const t = it.off ? ` title="${esc(it.why ?? 'Typora 有这一项，这个版本还没做')}"` : ''
    /* 右边只有这一个槽：有下级的画箭头图标（和标签同色 —— 图上量的：Typora 那个箭头
     * 95,99,104 和它那一行的标签是同一个数，比加速键的 71,71,71 深），没下级的画加速键。
     * 两项不许同时占这一槽：.mb-item 是 space-between，塞三个孩子会把中间那个甩到行中间去。 */
    const tail = sub ? `<span class="mb-arrow">${CHEVRON}</span>`
        : `<span class="mb-accel">${esc(it.accel ?? '')}</span>`
    return bar + `<div class="${cls}"${it.act && !it.off ? ` data-act="${it.act}"` : ''}${t}>`
        + `<span>${esc(it.label)}</span>${tail}`
        + (sub ? `<div class="mb-pop mb-sub">${sub.map(s => itemHtml(s, ctx)).join('')}</div>` : '')
        + '</div>'
}

/** 整条菜单条的 HTML。纯函数，所以"每一项都真的画出来了"能在 Node 里数 */
export function menuBarHtml(ctx: MenuCtx = DEFAULT_CTX): string {
    /* 每个"标签 + 它的弹层"必须包在一个定位父级里：弹层写的是 left:0，
     * 不包就相对整条菜单栏，所有下拉都开在最左边（和标签不对齐） */
    return MENUS.map((m, i) => '<div class="mb-menu">'
        + `<div class="mb-top" data-top="${i}" data-hot="${m.hotkey}">${esc(m.label)}</div>`
        + `<div class="mb-pop" data-pop="${i}">${m.items.map(it => itemHtml(it, ctx)).join('')}</div>`
        + '</div>').join('')
}

/*
 * 帮助浮层的内容 = 菜单表本身。为什么不再手写一份快捷键清单：手写那份和表迟早分家，
 * 而"菜单里有、帮助里没有"正是最容易骗人的一种不一致。所以这里现算，
 * 并且有条门禁盯着"每个带加速键的活项都出现在帮助里"。
 */
export function helpHtml(ctx: MenuCtx = DEFAULT_CTX): string {
    const rows = flatItems(ctx).filter(i => !i.off && i.accel)
    const byMenu = MENUS.map(m => {
        const items = m.items.flatMap(it => (it.dyn ? [] : [it, ...(it.sub ?? [])])).filter(i => !i.off && i.accel)
        if (!items.length) return ''
        return `<section class="hp-sec"><h3>${esc(m.label.replace(/\(.\)/, ''))}</h3>`
            + items.map(i => `<div class="hp-row"><span>${esc(i.label)}</span><kbd>${esc(i.accel ?? '')}</kbd></div>`).join('')
            + '</section>'
    }).join('')
    const grey = flatItems(ctx).filter(i => i.off).map(i => `<li>${esc(i.label)}${i.why ? ` —— ${esc(i.why)}` : ''}</li>`).join('')
    return `<h2>mdkit 快捷键</h2><div class="hp-grid">${byMenu}</div>`
        + `<h2>这一版还做不到的</h2><ul class="hp-off">${grey}</ul>`
        + `<div class="hp-note">共 ${rows.length} 条带加速键的动作。列表随菜单表现算，两边不会各说一套。</div>`
}
