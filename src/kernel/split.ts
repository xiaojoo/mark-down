/*
 * 顶层安全切分点扫描。
 *
 * 动机是实测出来的：micromark 在容器类块（引用、脚注定义）上是平方级 ——
 * 1 MB 文档 25% 引用块要 5887 ms，纯段落只要 1769 ms。整篇一次解析只适合
 * "打开文件"，逐块切开后每块单独解析，代价才跟文档长度线性。
 *
 * 这里只做**行级线性扫描**，判据一律取"保守"：拿不准就不切。少切只影响
 * 增量粒度，切错才会改变语法树 —— 后者由 test/chunked.test.ts 的差分测试
 * （分块结果 vs 整篇结果）来兜，不靠这段代码自己讲道理。
 *
/*
 * 允许下切的条件（全满足）：
 *   1. 不在围栏代码里
 *   2. 不在 html 块类型 1~5 里（这几类不吃空行结尾）
 *   3. 新行零缩进（缩进 >=4 会续上前面的缩进代码块，1~3 会续上列表项内容）
 *   4. 新行不是 setext 下划线（它会把上一行的段落吃掉）
 *   5. 新行不以列表标记开头（`- a` 空行 `- b` 是同一个松散列表，切开变两个）
 *
 * 引用块不在禁止之列：空行本身不带 `>`，引用就已经结束了（`> a` 里的空行是
 * `>` 那一行，它非空、走不到这里）。早先禁止 `>` 开头会让满屏引用的文档
 * 退化成"整篇一个区域"，实测 1 MB 那样要 112 秒。
 */

const RE_INDENT = /^[ \t]/
const RE_LIST_MARK = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
/* setext 下划线（=== / ---）不是块开头，而是把上一行的段落吃掉 */
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/
/* 块级公式 $$..$$ 可以跨空行：围栏之内不许下切（切了会把一个公式拆成两块） */
const RE_MATH_FENCE = /^ {0,3}\$\$[ 	]*$/
/* frontmatter 只可能是文档第一行，--- 或 +++；它内部的空行不算切点 */
const RE_FRONT = /^(---|\+\+\+)[ \t]*$/
/* 链接/脚注引用定义：作用域是整篇，所以每个区域都要带上它们 */
const RE_DEF = /^ {0,3}\[[^\]\n]+\]:/
/* 定义可以把标题写在第二行；只有这一种续行属于定义，别的都不吞 */
const RE_DEF_TITLE = /^ {0,3}(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))[ \t]*$/
/* 脚注定义：见下面 defAmbiguous 的说明，出现即不切 */
const RE_FOOT_DEF = /^ {0,3}\[\^([^\]\n]+)\]:/

/* html 块类型 1~5 的结束串；类型 6/7 空行即结束，不用管。
 * 顺序即优先级：CDATA 必须排在类型 4 的 `<!字母` 之前，否则会被类型 4 抢走 */
const HTML_END: [RegExp, string][] = [
    [/^ {0,3}<!--/, '-->'],
    [/^ {0,3}<\?/, '?>'],
    [/^ {0,3}<!\[CDATA\[/, ']]>'],
    [/^ {0,3}<![A-Za-z]/, '>'],
    [/^ {0,3}<(script|pre|style|textarea)\b/i, '$'],   /* 见下：按开标签配闭标签 */
]

function fenceClose(line: string, ch: string, len: number): boolean {
    const t = line.replace(/^ {0,3}/, '')
    let i = 0
    while (i < t.length && t[i] === ch) i++
    return i >= len && t.slice(i).trim() === ''
}

export interface TopScan {
    /** 每个顶层区域的起点，区间为 [bounds[i], bounds[i+1])，末段到 text.length */
    bounds: number[]
    /** 每个链接/脚注引用定义块的 [start, end)，end 落在其后的空行上 */
    defs: [number, number][]
    /** frontmatter 之后第一行的位置；只有文档真的以 frontmatter 开头才非空 */
    frontEnd: number | null
}

export function scanTop(text: string): TopScan {
    const bounds = [0]
    const defs: [number, number][] = []
    let pos = 0
    let fence: [string, number] | null = null
    let mathFence = false
    let htmlEnd: string | null = null
    let front: string | null = null
    let frontEnd: number | null = null
    let blankStart = -1
    /* 上一行是不是"空行或文档开头"：定义只有在这种位置才真的开启一个新块 */
    let prevBlank = true
    /* 见到无法证实的定义行（前面压着段落）—— 整篇就不再切了 */
    let defAmbiguous = false

    while (pos <= text.length) {
        const nl = text.indexOf('\n', pos)
        const start = pos
        const end = nl === -1 ? text.length : nl
        const line = text.slice(pos, end)
        pos = end + 1

        if (fence) {
            if (fenceClose(line, fence[0], fence[1])) { fence = null; prevBlank = true }
            continue
        }
        if (mathFence) {
            if (RE_MATH_FENCE.test(line)) { mathFence = false; prevBlank = true }
            continue
        }
        if (htmlEnd !== null) {
            if (line.includes(htmlEnd)) { htmlEnd = null; prevBlank = true }
            continue
        }
        if (front !== null) {
            if (line.trim() === front) { front = null; frontEnd = pos; prevBlank = true }
            continue
        }
        if (line.trim() === '') {
            if (blankStart < 0) blankStart = end + 1
            prevBlank = true
            continue
        }
        /* 先存下来：这一轮后面还要用它判"定义行是不是真的开了一个新块"，
         * 而 prevBlank 本身是给下一轮用的 */
        const wasBlank = prevBlank
        prevBlank = false

        if (blankStart >= 0) {
            if (canSplit(line)) bounds.push(blankStart)
            blankStart = -1
        }

        const fc = RE_FENCE.exec(line)
        if (fc) {
            fence = [fc[1][0], fc[1].length]
            continue
        }
        /* 块级公式的开头：$$ 单独一行。里面的空行不算切点，直到配上的那一行 */
        if (RE_MATH_FENCE.test(line)) { mathFence = true; continue }
        if (start === 0 && RE_FRONT.test(line)) {
            front = line
            continue
        }
        if (RE_DEF.test(line)) {
            /* 判不准就整篇不切 —— 少切只影响增量粒度，切错会改变语法树 */
            if (!wasBlank) defAmbiguous = true
            else {
                const fm = RE_FOOT_DEF.exec(line)
                if (fm) {
                    /* 脚注定义是贪吃容器：`[^a]: 内容` 后面紧跟 `1. 一` 时 mdast 让这个
                     * 定义一直吃到 31 个字符（实测），把复制进前缀的那份会连本区域的开头
                     * 一起吞掉。链接引用定义是叶子，没这问题。 */
                    defAmbiguous = true
                } else defs.push([start, defBlockEnd(text, end)])
            }
            continue
        }
        for (const [re, closer] of HTML_END) {
            if (!re.test(line)) continue
            htmlEnd = closer === '$' ? dollarEnd(line) : closer
            break
        }
    }
    if (defAmbiguous)
        return { bounds: frontEnd === null ? [0] : [0, frontEnd], defs: [], frontEnd }
    /* frontmatter 得独占第一个区域：它只在偏移 0 成立，而区域解析普遍要带定义前缀，
     * 前缀一挪位置，`---` 就退化成分隔线 + setext 标题了 */
    if (frontEnd !== null && bounds[1] !== frontEnd) bounds.splice(1, 0, frontEnd)
    return { bounds, defs, frontEnd }
}

/* 定义块 = 定义行 + 可选的标题行 */
function defBlockEnd(text: string, lineEnd: number): number {
    const here = Math.min(lineEnd + 1, text.length)
    const next = text.indexOf('\n', here)
    if (next === -1) return here
    return RE_DEF_TITLE.test(text.slice(here, next)) ? next + 1 : here
}

/* script/pre/style/textarea 的闭标签随开标签变；取不到就退回一个绝配不上的串，
 * 保守地让这段区域不再切分 */
function dollarEnd(line: string): string {
    const m = /^ {0,3}<(\w+)/.exec(line)
    return m ? `</${m[1].toLowerCase()}>` : '</never-closed>'
}

function canSplit(nextLine: string): boolean {
    return !RE_INDENT.test(nextLine)
        && !RE_LIST_MARK.test(nextLine)
        && !RE_SETEXT.test(nextLine)
}
