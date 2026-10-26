/*
 * 源码模式的高亮层（图一那种：标题有色、行内代码有底、`>` 灰、`|` 露着）。
 *
 * 它**只是显示**：真正在编辑的是压在它上面的一个透明文本域，所以这里正则写错
 * 最多是颜色不对，动不了文档一个字。忠实性由一条判据守着：剥掉所有标签后的文字
 * 必须逐字符等于原文（test/source-hl.test.ts）。
 *
 * 行号和文本域能对齐的前提也是这条：一行源码 = 一个 .hl-line，两边都不换行。
 */

/** 行内标记：`code`、**粗**、*斜*、~~删~~、[文字](链接)、![图](地址)、<自动链接> */
const INLINE_RE = /(`+[^`\n]*`+)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(~~[^~\n]+~~)|(!?\[[^\]\n]*\]\([^)\n]*\))|(<https?:\/\/[^>\n]+>)/g

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 把一行正文按行内语法切开：记号归 hl-meta（显出来但压暗），内容归 hl-<类型> */
function inlineHtml(line: string): string {
    let out = ''
    let at = 0
    for (const m of line.matchAll(INLINE_RE)) {
        const i = m.index ?? 0
        if (i > at) out += esc(line.slice(at, i))
        const whole = m[0]
        const kind = m[1] ? 'code' : m[2] ? 'strong' : m[3] ? 'em' : m[4] ? 'del' : m[5] ? 'link' : 'auto'
        if (kind === 'code' || kind === 'link' || kind === 'auto') {
            /* 这三种整段一起给一个类：它们的首尾记号本身就是这类语法的一部分 */
            out += `<span class="hl-${kind === 'auto' ? 'link' : kind}">${esc(whole)}</span>`
        } else {
            const n = whole.startsWith('__') || whole.startsWith('~~') ? 2 : kind === 'strong' ? 2 : 1
            out += `<span class="hl-meta">${esc(whole.slice(0, n))}</span>`
                + `<span class="hl-${kind}">${esc(whole.slice(n, whole.length - n))}</span>`
                + `<span class="hl-meta">${esc(whole.slice(whole.length - n))}</span>`
        }
        at = i + whole.length
    }
    return out + esc(line.slice(at))
}

/** 这一行属于哪种块：决定它的配色 */
function lineClass(line: string, inFence: boolean, inFront: boolean): string {
    if (inFront) return 'hl-front'
    if (inFence) return 'hl-code-line'
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return 'hl-fence'
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) return 'hl-h'
    if (/^ {0,3}>/.test(line)) return 'hl-quote'
    if (/^ {0,3}([-*+] |\d+\. )/.test(line)) return 'hl-li'
    if (/^\s*\|/.test(line)) return 'hl-tr'
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return 'hl-hr'
    if (/^\[\^?[^\]]+\]:/.test(line)) return 'hl-def'
    return ''
}

/** 整篇源码 → 一行一个 div 的高亮 HTML。围栏 / frontmatter 状态逐行走。 */
export function highlightSource(text: string): string {
    const lines = text.split('\n')
    const close = lines[0] === '+++' ? '+++' : '---'
    let inFence = false
    let fenceMark = ''
    let inFront = lines[0] === '---' || lines[0] === '+++'
    return lines.map((line, i) => {
        const cls = lineClass(line, inFence, inFront)
        if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
            const mark = (/^ {0,3}(`{3,}|~{3,})/.exec(line) ?? ['', ''])[1][0]
            if (!inFence) { inFence = true; fenceMark = mark }
            else if (mark === fenceMark) inFence = false
        }
        const body = cls === 'hl-code-line' || cls === 'hl-fence' ? esc(line) : inlineHtml(line)
        if (i > 0 && inFront && line === close) inFront = false
        return `<div class="hl-line ${cls}">${body}</div>`
    }).join('')
}
