import { esc } from './html.ts'
import { THEME_CSS } from '../styles/themeCss.ts'
import { KATEX_CSS } from '../styles/katexCss.ts'

/*
 * 导出一份**自包含**的 HTML：正文用同一个渲染器生成，样式整份内联。
 * 之所以内联，是因为要导出的页面可能在 file:// 下打开，外链一份 CSS
 * 要么带不走、要么带出去就断；自包含一份文件才是"该写盘的都在本地"。
 *
 * 标题与正文都过 esc()；`<script>` 一类不放进来（连渲染器都不注入文档内容，
 * 导出这一路也不给注入留第二个口子）。
 */
export function exportHtml(title: string, bodyHtml: string, extraCss = ''): string {
    return '<!doctype html>\n<html lang="zh-CN" data-theme="light">\n<head>\n'
        + '<meta charset="utf-8">\n'
        + `<title>${esc(title)}</title>\n`
        /* 页面设置那条 @page 跟在主题后面：同一份导出，纸和边距得和屏幕上打印看到的一致 */
        + '<style>\n' + THEME_CSS + (extraCss ? '\n' + extraCss + '\n' : '') + '</style>\n'
        + '</head>\n<body>\n<div id="app">\n<div id="main">\n<div id="scroll">\n'
        + `<div id="write">\n${bodyHtml}\n</div>\n</div>\n</div>\n</div>\n</body>\n</html>\n`
}

export const THEME_CSS_BYTES = THEME_CSS.length

/*
 * 导出里的公式：KaTeX 那份 CSS 整份带过去很便宜（23 KB），贵的是字体。
 * 所以只带这份文档**真正用到**的那几只字面 —— 依据是 CSS 自己：
 * `.katex .mathbb{font-family:KaTeX_AMS}` 给出"类名 → 字族"，渲染结果里出现过这个类名，
 * 那个字族才需要。每只 @font-face 只留 woff2（现代浏览器都用它），woff/ttf 那两份丢掉。
 */
export function hasMath(html: string): boolean {
    return html.includes('class="katex')
}

/** 渲染结果里出现过的类名 */
function classesIn(html: string): Set<string> {
    const out = new Set<string>()
    for (const m of html.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (c) out.add(c)
    return out
}

/** 这份 CSS 里被用到的字族（KaTeX_Main 是 .katex 那条 shorthand 定的，永远要用到） */
export function neededFamilies(html: string, css = KATEX_CSS): Set<string> {
    const used = classesIn(html)
    const out = new Set<string>(['KaTeX_Main'])
    for (const m of css.matchAll(/([^@{}]+)\{([^{}]+)\}/g)) {
        const fams = [...m[2].matchAll(/font(?:-family)?:[^;}]*?(KaTeX_[A-Za-z]+)/g)].map(x => x[1])
        if (!fams.length) continue
        /* 取每个选择器**最后**那个类名：KaTeX 的规则都是 `.katex .mathbb` 这种，
         * 真正决定字族的是后面那个。把 .katex 也算进来会让每一条都命中（它永远在），
         * 于是六十几只字体全带上 —— 实测就是这样，一条都没省下 */
        const last = m[1].split(',').map(sel => {
            const names = [...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map(x => x[1])
            return names.length ? names[names.length - 1] : ''
        })
        if (last.includes('katex')) for (const f of fams) out.add(f)
        else if (last.some(n => n && used.has(n))) for (const f of fams) out.add(f)
    }
    return out
}

/** 把 @font-face 换成"只留用到的、且只留 woff2 的 data URI"版本，其余规则原样 */
export function katexSubset(html: string, fonts: Record<string, string>, css = KATEX_CSS): string {
    const need = neededFamilies(html)
    return css.replace(/@font-face\{[^}]*\}/g, block => {
        const fam = /font-family:(KaTeX_[A-Za-z]+)/.exec(block)?.[1] ?? ''
        if (!need.has(fam)) return ''
        const file = /url\((fonts\/[^)]+\.woff2)\)/.exec(block)?.[1] ?? ''
        const b64 = fonts[file]
        if (!b64) return block                            /* 字体表没注入：留着相对路径，至少应用里能显示 */
        const style = /font-style:([a-z]+)/.exec(block)?.[1] ?? 'normal'
        const weight = /font-weight:(\d+)/.exec(block)?.[1] ?? '400'
        return `@font-face{font-family:${fam};font-style:${style};font-weight:${weight};`
            + `src:url(data:font/woff2;base64,${b64}) format("woff2")}`
    })
}
