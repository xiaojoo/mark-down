import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_CSS } from '../src/styles/themeCss.ts'
import { openChunked, blocks } from '../src/kernel/parse.ts'
import { renderBlocks } from '../src/render/html.ts'
import { ROUNDTRIP } from './corpus.ts'

/*
 * 生成物防漂移：导出用的那份 CSS 常量是 tools/gen-css.mjs 从 theme.css 抄出来的。
 * 抄一次容易，改了 theme.css 忘了重新抄就变成"屏上一个样、导出的 HTML 另一个样"，
 * 而且两边各自都能跑、没人报错。这条逐字节比对就是那声报错。
 */
describe('导出用的 CSS 与屏上那份是同一份', () => {
    it('themeCss.ts 与 theme.css 逐字节相同', () => {
        expect(THEME_CSS).toBe(readFileSync('src/styles/theme.css', 'utf8'))
    })

    it('不是空串或半个文件（生成步骤真跑过）', () => {
        expect(THEME_CSS.length).toBeGreaterThan(4000)
        expect(THEME_CSS).toContain('.md-meta')
        expect(THEME_CSS).toContain('@media print')
        expect(THEME_CSS).toContain('[data-theme="newsprint"]')
    })
})

/*
 * 主题契约的另一半：CSS 里点名的 .md-* 类，渲染器必须真发得出来。
 * 起因是 .md-inlineCode —— 渲染器发的叫 md-code-inline，这条选择器永不命中，
 * 于是行内代码既没等宽也没底色，而两边各自的测试都绿（CSS 测的是文本，渲染测的是类名）。
 * 同一把尺子当场又抓到两条：.md-autolink（mdast 不给自动链接单独节点，压根发不出）
 * 和 .md-fence 那条无规则的类名。
 * 白名单是应用层自己加在 DOM 上的状态类，不经渲染器。
 */
describe('主题里点名的类名渲染器发得出来', () => {
    const APP_OWNED = new Set(['md-editing', 'md-src', 'md-hit', 'md-hit-current', 'md-hit-block',
        'md-body', 'md-source-all', 'md-block', 'md-ln-here', 'md-band', 'md-ln', 'md-src-hl',
        /* 量行源码宽度的临时量具，量完就拆（main.ts 的 naturalWidth） */
        'md-measure'])
    /* frontmatter 只在偏移 0 成立，所以每份单独一篇；其余凑一篇就够 */
    const CONTRACT = [
        '---\ntitle: t\n---\n\n# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n\n'
        + '> [!NOTE]\n> n\n\n> [!TIP]\n> t\n\n> [!IMPORTANT]\n> i\n\n> [!WARNING]\n> w\n\n> [!CAUTION]\n> c\n\n'
        + '![图](u.png)\n\na `b` [c](u) <https://a.b> [^n] ~~e~~ *d* **f** 正文  \n换行\n\n'
        + '| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] 任务\n\n```f\ncode\n```\n\n    缩进代码\n\n<div>html</div>\n\n---\n\n[a]: u "t"\n\n[^n]: 脚注\n',
        '+++\nk = 1\n+++\n\n正文\n',
        /* 格式菜单那三条插的是 HTML 标签：不放进契约样本里，.md-mark 就是条渲染发不出的死规则 */
        /* 前面垫一个标题：这一圈是拿 editing:0 渲染的，第 0 块会换成编辑框、行内标签就发不出来了 */
        '# 标\n\n上标 x<sup>2</sup> 下标 y<sub>1</sub> 高亮 <mark>记</mark> 注 <!-- c -->\n',
    ]
    const emitted = new Set([...ROUNDTRIP.map(([, s]) => s), ...CONTRACT].flatMap(src => {
        const c = openChunked(src)
        const html = renderBlocks(blocks(c), { text: c.text, editing: 0, marks: [{ start: 0, end: 1 }], current: 0 })
        return (html.match(/class="[^"]*"/g) ?? []).flatMap(m => m.slice(7, -1).split(/\s+/))
    }))
    /*
     * md-iu（一个加粗串/一段行内代码换成行内大小的框）发在"点在行内单元上"那一遍里，
     * 上面那圈都进不到这种状态。区间不写死：从普通渲染里读 md-strong 自己标的 data-s/e，
     * 于是这条顺便还证明了"单元类名身上带着可点回来的字节区间"。
     * 句子两边得有别的字：整段只有一个加粗串时，加粗串的区间=段落的区间，那就走整块那条路了。
     */
    {
        const c = openChunked('x **粗** y\n')
        const bs = blocks(c)
        const m = /class="md-strong md-eu" data-s="(\d+)" data-e="(\d+)"/.exec(
            renderBlocks(bs, { text: c.text, editing: -1 }))
        if (!m) throw new Error('md-strong 没带上 data-s/data-e，这条尺子失效了')
        const html = renderBlocks(bs, { text: c.text, editing: 0, editRange: { start: +m[1], end: +m[2] } })
        for (const cl of (html.match(/class="[^"]*"/g) ?? []).flatMap(x => x.slice(7, -1).split(/\s+/)))
            emitted.add(cl)
    }
    /* CSS 注释里也会写类名（就是解释"这条为什么删了"的地方），要先剥掉再抽选择器 */
    const named = (css: string) => [...new Set((css.replace(/\/\*[\s\S]*?\*\//g, '')
        .match(/\.md-[A-Za-z0-9_-]+/g) ?? []).map(s => s.slice(1)))]
    const dead = (css: string) => named(css).filter(c => !emitted.has(c) && !APP_OWNED.has(c))

    it('每条 .md-* 选择器都在渲染结果里命中过（或明说是应用层状态类）', () => {
        expect(dead(THEME_CSS)).toEqual([])
    })
    /* 反证：给一个渲染器发不出来的类名写规则，这条必须报红 */
    it('反证：改名后的类会被抓出来', () => {
        expect(dead(THEME_CSS.replace('.md-code-inline {', '.md-code-inline-RENAMED {')))
            .toContain('md-code-inline-RENAMED')
    })
})

/*
 * 目录弹层的右缘必须压在侧栏那条分隔线上，否则两条竖线隔几像素一起露着（他报的"多余的边框"）。
 * 分隔线的位置 = #main 第一列的宽度，所以这块的宽度只能来自同一个令牌；
 * 谁再写死一个数（15rem / 240px 之类），两条线就又错开了。
 */
describe('目录弹层的边框和侧栏分隔线同源', () => {
    const css = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = /#dirpop \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const ok = (r: string) => /width: var\(--side-w\)/.test(r) && /box-sizing: border-box/.test(r)
        && /border-bottom: 0/.test(r)
    /* 面板必须一路开到底（下沿 = 窗口底）：坐在状态栏顶边上会在面板底下留一条 25px 空带。
     * 判据要锚在声明的边界上 —— 光写 /bottom: 0;/ 会被同一块里的 border-bottom: 0; 命中
     * （反证那条一开始就是被这个骗过去的，改完它才真的报红） */
    const reachesBottom = (r: string) => /(?:^|;)\s*bottom: 0;/.test(r)
    it('现在的 #dirpop 四条都满足', () => {
        expect(rule).not.toBe('')
        expect(ok(rule)).toBe(true)
        expect(reachesBottom(rule)).toBe(true)
    })
    it('侧栏收起时面板跟着回到左缘（否则被推出屏外）', () => {
        expect(css).toMatch(/body\.no-side #dirpop \{ left: 0; \}/)
    })
    it('--side-w 就是左列的宽（#app 的列、弹层的宽、弹层的左移，三处同一个数）', () => {
        expect(css).toMatch(/#app \{[^}]*grid-template-columns: var\(--side-w\) 1fr/)
        expect(css).toMatch(/--side-w: \d+px/)
        expect(rule).toMatch(/left: calc\(-1 \* var\(--side-w\)\)/)
    })
    /* 反证：四种退路各自都要被判不过，否则这条门禁等于没写 */
    it('反证：写死宽度 / 丢 border-box / 补回下边框 / 面板不贴窗口底，都过不了', () => {
        expect(ok(rule.replace('width: var(--side-w)', 'min-width: 15rem'))).toBe(false)
        expect(ok(rule.replace('box-sizing: border-box;', ''))).toBe(false)
        expect(ok(rule.replace('border-bottom: 0', 'border-bottom: 1px'))).toBe(false)
        expect(reachesBottom(rule.replace(/(^|;)\s*bottom: 0;/, '$1 bottom: calc(100% + 1px);'))).toBe(false)
    })
})

/*
 * 底部要分成左右两栏：左列 = 侧栏那一列（它的分隔线穿过状态栏画到窗口底），
 * 右格 = 状态栏。这件事只能由 #app 的网格说，不能靠状态栏自己加 240px 内衬 ——
 * 内衬那条路下，分隔线还是走到状态栏顶就停，看着就是没分栏。
 */
describe('底部左右两栏由 #app 的网格分', () => {
    const css = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const html = readFileSync('app/index.html', 'utf8')
    const app = /#app \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const spansRows = (s: string) => /#side \{[^}]*grid-column: 1; grid-row: 3 \/ 5/.test(s)
    const inRightCell = (s: string) => /#status \{ grid-column: 2; grid-row: 4; \}/.test(s)
    it('#app 是两列，左列宽 = --side-w', () => {
        expect(app).not.toBe('')
        expect(app).toMatch(/grid-template-columns: var\(--side-w\) 1fr/)
        expect(app).toMatch(/grid-template-rows: auto auto 1fr auto/)
    })
    it('侧栏占到第 4 行（分隔线穿过状态栏），状态栏只在右格', () => {
        expect(spansRows(css)).toBe(true)
        expect(inRightCell(css)).toBe(true)
        expect(css).toMatch(/body\.no-side #app \{ grid-template-columns: 0 1fr; \}/)
    })
    it('#side 必须是 #app 的直接孩子（在 #main 里就跨不了行）', () => {
        expect(html.indexOf('<nav id="side">')).toBeLessThan(html.indexOf('<div id="main">'))
        expect(html).not.toMatch(/<div id="main">\s*<nav id="side">/)
    })
    /* 反证：把侧栏收回第 3 行、或状态栏退回整行，两条判据各自都要翻脸 */
    it('反证：两种退路都过不了', () => {
        expect(spansRows(css.replace('grid-row: 3 / 5', 'grid-row: 3'))).toBe(false)
        expect(inRightCell(css.replace('#status { grid-column: 2; grid-row: 4; }', ''))).toBe(false)
    })
})

/*
 * 折叠侧栏那颗图标：画的（不是字符），收起时掉头，且和菜单项 / Ctrl+Shift+L 共用一个状态。
 */
describe('折叠侧栏那颗图标', () => {
    const css = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const app = readFileSync('src/app/main.ts', 'utf8')
    it('是画的图标，侧栏收着时掉头成"放回来"', () => {
        expect(app).toMatch(/const SIDE_SVG = '<svg/)
        expect(app).toMatch(/id="st-side".*SIDE_SVG/)
        expect(css).toMatch(/body\.no-side #st-side svg \{ transform: rotate\(180deg\); \}/)
    })
    it('和菜单项、快捷键共用同一个开关（不另存一份状态）', () => {
        expect(app).toMatch(/closest\('#st-side'\)\) \{ toggleView\('sidebar'\)/)
        expect(app).toMatch(/sidebar: \(\) => document\.body\.classList\.toggle\('no-side'\)/)
    })
    it('反证：掉头规则删掉就报红', () => {
        expect(/body\.no-side #st-side svg/.test(css.replace(/body\.no-side #st-side svg \{[^}]*\}/, ''))).toBe(false)
    })
})

/*
 * 皮对皮的颜色门禁：算对比度，不看"像不像"。
 * 起因是两条真 bug：① 子菜单的字继承悬停那行的白字 → 浅色三套皮上白字白底；
 * ② 深色皮的 accent 是亮蓝，压白字只有 2.5:1。前者靠 .mb-item 自己声明 color 治了，
 * 后者靠 --on-accent 治了；这条把两件事都变成算得出来的数，以后改令牌当场见红。
 */
describe('每套皮的对比度', () => {
    const raw = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const block = (sel: string) => {
        const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(raw)
        return m ? m[1] : ''
    }
    const tokens = (body: string) => Object.fromEntries(
        [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)].map(m => [m[1], m[2]])) as Record<string, string>
    const root = tokens(block(':root'))
    const themes: [string, Record<string, string>][] = [['默认', root], ...['dark', 'newsprint', 'minimal']
        .map(t => [t, { ...root, ...tokens(block(`[data-theme="${t}"]`)) }] as [string, Record<string, string>])]
    const lum = (hex: string) => {
        const h = hex.slice(1)
        const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h
        const v = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255)
            .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
    }
    const cr = (a: string, b: string) => {
        const x = lum(a), y = lum(b)
        return Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100
    }
    for (const [name, t] of themes) {
        it(`${name}：正文压在底色上 ≥ 7`, () => { expect(cr(t.fg, t.bg)).toBeGreaterThanOrEqual(7) })
        it(`${name}：反白那对（on-accent 压在 accent 上）≥ 4.5`, () => {
            expect(t['on-accent']).toBeTruthy()
            expect(cr(t['on-accent'], t.accent)).toBeGreaterThanOrEqual(4.5)
        })
    }
    it('反证：把 on-accent 退回写死的白字，深色皮当场过不了', () => {
        const d = themes.find(x => x[0] === 'dark')![1]
        expect(cr('#ffffff', d.accent)).toBeLessThan(4.5)
    })
})

/*
 * 结构上堵住同一个洞：子面板挂在带 sub 的那一行里面，那一行悬停时刷的字色
 * 会一路继承下去 —— 所以 .mb-item 必须自己声明 color，后代规则必须写成直接孩子。
 */
describe('子菜单不许继承悬停那行的字色', () => {
    const css = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const item = /\.mb-item \{([^}]*)\}/.exec(css)?.[1] ?? ''
    it('.mb-item 自己声明 color（不靠继承）', () => {
        expect(item).not.toBe('')
        expect(item).toMatch(/color: var\(--fg\)/)
    })
    it('悬停的加速键规则只打直接孩子', () => {
        expect(css).toMatch(/\.mb-item:hover > \.mb-accel/)
        expect(css).not.toMatch(/\.mb-item:hover \.mb-accel/)
    })
    it('反证：去掉那条显式 color，判据就翻脸', () => {
        expect(item.replace('color: var(--fg); ', '')).not.toMatch(/color: var\(--fg\)/)
    })
})

/*
 * 文档名只出现一次：写在**窗口标题**上（图标右边），不再在页面顶栏里另摆一条。
 * 独立应用窗口（app.bat 的 --app=）的标题栏文字取的就是 document.title。
 */
describe('文档名走窗口标题，页面里不重复', () => {
    const html = readFileSync('app/index.html', 'utf8')
    const app = readFileSync('src/app/main.ts', 'utf8')
    it('main.ts 把 name 写进 document.title', () => {
        expect(app).toMatch(/document\.title = name/)
        expect(app).toMatch(/setDocTitle\(name\)/)
        expect(app).toMatch(/setDocTitle\(h\.name\)/)      /* 另存为也要跟着改 */
    })
    const hasBar = (s: string) => /id="title-bar"/.test(s)
    it('页面里没有第二条 #title-bar（CSS 里也没有它的规则）', () => {
        expect(hasBar(html)).toBe(false)
        expect(THEME_CSS).not.toMatch(/#title-bar\s*\{/)
    })
    it('反证：把那条 span 放回去，这把尺子要能认出来', () => {
        expect(hasBar(html + '<span id="title-bar">x</span>')).toBe(true)
    })
})

/*
 * 视图模式的类名是加在 #write **自己身上**的（main.ts 的 toggleView）。
 * CSS 里写成 ".typewriter #write" 就变成要求它有个带该类的祖先 —— 永远选不中，
 * 而 CSS 测文本、应用测类名，两边各自都绿。这条把两边的锚点对上。
 * 实测：改之前 ".typewriter #write" 命中 0 个元素，"#write.typewriter" 命中 1 个。
 */
describe('模式类名的宿主和 CSS 选择器一致', () => {
    const app = readFileSync('src/app/main.ts', 'utf8')
    const css = THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const onWrite = [...app.matchAll(/write\.classList\.toggle\('([\w-]+)'\)/g)].map(m => m[1])
    /* 先钉住"确实扫到了这两个类"：扫不到就一条测试都不会生成，等于门禁自己失效 */
    it('main.ts 在 #write 上切的就是 focus / typewriter', () => {
        expect([...onWrite].sort()).toEqual(['focus', 'typewriter'])
    })
    for (const cls of onWrite) it(`.${cls} 不被写成 #write 的祖先`, () => {
        expect(css).not.toMatch(new RegExp(`\.${cls}[^{,]*#write`))
        expect(css).toContain(`.${cls}`)
    })
})

/*
 * 悬停提示必须是自绘的（他点名"气泡不要使用系统气泡，自己绘画一个"）。
 * 原生 title 那一发是 Chrome 画的：字号、底色、圆角都不归主题管，深色皮上就是一块灰补丁。
 * 写法照旧是 title（他早先定的：全局拦截，别要求每个新控件记得挂新属性），
 * 由 main.ts 的 wireTips 在 pointerover 上把属性截走 —— 所以这里查的是**截走这一步还在不在**。
 */
describe('悬停提示走自绘气泡', () => {
    const app = readFileSync('src/app/main.ts', 'utf8')
    it('pointerover 上把 title 截走搬到 data-tip', () => {
        expect(app).toMatch(/removeAttribute\('title'\)/)
        expect(app).toMatch(/dataset\.tip = t/)
    })
    it('置灰的按钮不给提示（原生 title 在 disabled 上本来就不显示）', () => {
        expect(app).toMatch(/disabled\) return null/)
    })
    it('反证：删掉截走那一步，这条要报红', () => {
        expect(app.replace(/removeAttribute\('title'\)/, 'void 0')).not.toMatch(/removeAttribute\('title'\)/)
    })
    it('自绘气泡的外壳还在（含尖角那一层）', () => {
        expect(THEME_CSS).toContain('#tip.on')
        expect(THEME_CSS).toContain('#tip::after')
        expect(THEME_CSS).toContain('#tip.below::after')
    })
})
