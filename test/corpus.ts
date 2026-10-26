/*
 * 三套门禁共用的语料：往返全等、分块同构、偏移映射。
 * 放在一处是为了让它们量的是**同一批文档** —— 换一批语料就得三把尺子一起换。
 */

/* 每一条要求 serializeDoc(parse(src)) 与 src 逐码元相等。
 * 覆盖面按 CommonMark 的块类型 + GFM 扩展 + 换行风格/BOM/制表符来挑。 */
export const ROUNDTRIP: [string, string][] = [
    ['空文档', ''],
    ['仅一个换行', '\n'],
    ['仅空行', '\n\n\n'],
    ['单段', 'hello world\n'],
    ['无尾换行', 'a'],
    ['段间多空行', 'a\n\n\nb\n'],
    ['前导空行', '\n\na\n'],
    ['尾部空行', 'a\n\n\n\n'],
    ['atx 标题族', '# h1\n## h2\n###### h6\n'],
    ['atx 闭合井', '## hi ##\n'],
    ['atx 无空格', '#h\n'],
    ['setext', 'title\n===\nsub\n---\n'],
    ['引用', '> a\n> b\n'],
    ['引用惰性续行', '> a\nb\n'],
    ['嵌套引用', '> > a\n'],
    ['引用内列表', '> - x\n>   y\n'],
    ['引用带空标记行', '> a\n>\n> b\n'],
    ['无序列表', '- one\n- two\n'],
    ['嵌套列表', '- one\n  - two\n- three\n'],
    ['松散列表', '- a\n\n- b\n'],
    ['列表末空行', '- a\n\n'],
    ['有序宽标记', '10. ten\n    cont\n'],
    ['括号序号', '1) a\n2) b\n'],
    ['任务列表', '- [ ] todo\n- [x] done\n'],
    ['列表项含围栏代码', '- a\n\n  ```\n  x\n  ```\n'],
    ['围栏代码', '```ts\nlet a = 1\n```\n'],
    ['围栏 info 带空格', '````  foo bar\n````\n'],
    ['围栏内空行', '```\na\n\nb\n```\n'],
    ['未闭合围栏', '```\nx\n'],
    ['缩进代码', '    code\n'],
    ['缩进代码带空行', '    a\n\n    b\n'],
    ['制表符缩进代码', '\tcode\n'],
    ['分隔线', '***\n'],
    ['分隔线带空格', '- - -\n'],
    ['分隔线黏段', 'a\n---\nb\n'],
    ['html 块', '<div>\n  <p>x</p>\n</div>\n'],
    ['html 注释', '<!-- c -->\n'],
    ['frontmatter yaml', '---\ntitle: x\n---\nbody\n'],
    ['gfm 表格', '| a | b |\n| :-: | -: |\n| 1 | 2 |\n'],
    ['gfm 表格无外管', 'a | b\n-- | --\n1 | 2\n'],
    ['gfm 删除线', '~~x~~\n'],
    ['gfm 自动链接', 'https://example.com/\n'],
    ['gfm 脚注', 'x[^1]\n\n[^1]: note\n'],
    ['跨行强调', 'a *b\n c* d\n'],
    ['链接带标题', '[t](u "ti")\n'],
    ['图片', '![a](i.png)\n'],
    ['行内代码', 'use `a` b\n'],
    ['硬换行', 'a  \nb\n'],
    ['反斜杠硬换行', 'a\\\nb\n'],
    ['引用式链接', '[a][1]\n\n[1]: u\n'],
    ['定义紧贴 setext', 'x\n\n[1]: u\nsetext\n===\n'],
    ['脚注定义紧贴 setext', 'x\n\n[^1]: u\nsetext\n===\n'],
    ['混合行内', '**b** `c` [d](e) *f* ~~g~~ h[^1]\n\n[^1]: x\n'],
    ['中文与 emoji', '# 标题 ✨\n\n中文 **粗** 🐂\n'],
    ['CRLF 整篇', 'a\r\n\r\nb\r\n'],
    ['CRLF 列表', '- a\r\n- b\r\n'],
    ['BOM', '\ufeff# h\n'],
    ['BOM 加 CRLF', '\ufeffa\r\nb\r\n'],
    ['表格内含行内标记', '| **粗** | `码` |\n| - | - |\n| [x](u) | ![i](a.png) |\n'],
    ['综合文档', '# T\n\n> quote\n\n- [ ] a\n- [x] b\n\n```js\nx\n```\n\n| a |\n| - |\n| 1 |\n\n[^1]\n\n[^1]: n\n'],
]

export const FRAGS = [
    '# 标题\n\n',
    '普通段落 *粗* 和 [链接](u)。\n\n',
    '> 引用\n> 第二行\n\n',
    '> 引用\n>\n> 两段\n\n',
    '- 甲\n- 乙\n\n',
    '- 甲\n\n  续段\n\n',
    '1. 一\n2. 二\n\n',
    '```js\n\nlet a = 1\n\n```\n\n',
    '~~~\n```\n~~~\n\n',
    '    缩进代码\n\n    还是缩进代码\n\n',
    '| a | b |\n| - | - |\n| 1 | 2 |\n\n',
    '<!-- 注释\n跨行\n-->\n\n',
    '<div>\nx\n</div>\n\n',
    '<pre>\n\n仍然在 pre 里\n</pre>\n\n',
    '---\ntitle: x\n\n空行也在 frontmatter 里\n---\n\n正文\n\n',
    'setext\n===\n\n',
    '***\n\n',
    '引用式 [1] 用法\n\n[1]: http://u\n\n',
    '带脚注 [^a]\n\n[^a]: 内容\n\n',
    '再看 [1] 和 [^a]\n\n',
    '- 甲\n\n  [1]: u\n\n',
    '[1]: http://u\n"标题在第二行"\n\n再引 [1]\n\n',
    '~~删~~ 与 https://e.com/\n\n',
    '中文段落 🐂\n\n',
    '| **粗** | `码` |\n| :-: | - |\n| [x](u) | 文字 [^a] |\n\n',
]

export function mulberry(seed: number): () => number {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/* 随机拼文档；抹掉尾随空行那一路是为了让相邻片段互相吞并 */
export function randomDocs(count: number, seed: number): string[] {
    const rand = mulberry(seed)
    const out: string[] = []
    for (let d = 0; d < count; d++) {
        const n = 1 + Math.floor(rand() * 10)
        let s = ''
        for (let i = 0; i < n; i++) {
            let f = FRAGS[Math.floor(rand() * FRAGS.length)]
            if (rand() < 0.25) f = f.replace(/\n\n$/, '\n')
            s += f
        }
        out.push(s)
    }
    return out
}
