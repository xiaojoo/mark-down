import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MENUS, NOT_DONE, ACCELS_WITH_SOURCE, allItems, flatItems, helpHtml, menuBarHtml, DEFAULT_CTX } from '../src/app/menu.ts'
import { createActions, inlineSource, tocOf, toReference, nextRefId, nextFootnote, clearInline, targetText, insertText, escapeMd, toEol, headings, nextCopyName, pushRecent, filterFiles, htmlToMd, articleOrder, folderOf, ENCODINGS, SUBRULES, substitute, pageCss, type Host } from '../src/app/actions.ts'
import { parse, openChunked, blocks, chunkedRoot, serializeChunked } from '../src/kernel/parse.ts'
import { span } from '../src/kernel/node.ts'

/* 他给的那张图就是判据：五个顶层菜单的名字必须逐字一样 */
describe('菜单条的形状 = Typora', () => {
    it('顶层就是图里那五个，一字不差', () => {
        expect(MENUS.map(m => m.label)).toEqual(['文件(F)', '编辑(E)', '段落(P)', '格式(O)', '视图(V)'])
    })

    it('每个菜单都有内容，且顺序稳定', () => {
        for (const m of MENUS) expect(m.items.length).toBeGreaterThan(6)
        expect(MENUS[2].items[0].label).toBe('一阶标题')
        expect(MENUS[3].items[0].label).toBe('粗体')
    })
})

/*
 * 死菜单项门禁：菜单最容易烂成"看着有、点了没反应"。
 * 规则是 —— 要么有动作且动作真的存在，要么明写 off 且 off 的集合必须与 NOT_DONE 完全相等。
 */
describe('不许有死菜单项', () => {
    const items = allItems()

    function fakeHost(): Host & { log: string[] } {
        const log: string[] = []
        return {
            log,
            text: '段落 文字\n',
            blockNode: parse('段落 文字\n').root.children[0],
            blockRange: { start: 0, end: 10 },
            selection: null,
            renderedHtml: () => '<p>段落 文字</p>',
            splice: (f, t, ins) => log.push(`splice ${f} ${t} ${JSON.stringify(ins)}`),
            replaceAll: t => log.push(`replace ${JSON.stringify(t)}`),
            afterBlock: ins => log.push(`after ${JSON.stringify(ins)}`),
            atDocStart: ins => log.push(`head ${JSON.stringify(ins)}`),
            atDocEnd: ins => log.push(`tail ${JSON.stringify(ins)}`),
            undo: () => log.push('undo'), redo: () => log.push('redo'),
            fileNew: () => log.push('new'), fileOpen: () => log.push('open'),
            fileOpenDir: () => log.push('dir'), save: () => log.push('save'),
            saveAs: () => log.push('saveAs'), exportHtmlFile: () => log.push('export'),
            print: () => log.push('print'), newWindow: () => log.push('window'),
            copy: t => log.push(`copy ${t.length}`),
            toggle: n => log.push(`toggle ${n}`), fullscreen: () => log.push('fs'),
            findPanel: r => log.push(`find ${r}`),
            zoom: d => log.push(`zoom ${d}`), theme: t => log.push(`theme ${t}`),
            selectAll: () => log.push('selectAll'), paste: p => log.push(`paste ${p}`),
            closeDoc: () => log.push('close'), revert: () => log.push('revert'),
            speak: t => log.push(`speak ${t.length}`), spellcheck: () => log.push('spell'),
            lineEnding: e => log.push(`eol ${e}`), jumpTo: i => log.push(`jump ${i}`),
            reopenEncoding: e => log.push(`enc ${e}`), openRecent: n => log.push(`recent ${n}`),
            quickOpen: () => log.push('quick'), duplicate: () => log.push('dup'),
            rename: () => log.push('rename'), moveToDir: () => log.push('move'),
            importFile: () => log.push('import'),
            newTab: () => log.push('tab'), switchDocs: w => log.push(`doc ${w}`),
            articles: () => log.push('articles'), help: () => log.push('help'),
            imageMode: m => log.push(`img ${m}`), imageProps: () => log.push('props'),
            substitution: id => log.push(`sub ${id}`), pageSetup: () => log.push('page'),
        }
    }

    it('每个 off 项都在 NOT_DONE 里登记，且没有多余的登记', () => {
        /* 按集合比：行内公式在 格式 里一条、在 编辑›数学工具 里又一条（Typora 就是两个入口），
         * 重复登记不是缺陷，缺登记才是 */
        const offs = [...new Set(items.filter(i => i.off).map(i => i.act as string))].sort()
        expect(offs).toEqual([...new Set([...NOT_DONE])].sort())
        expect(items.filter(i => i.off && !i.act).map(i => i.label)).toEqual([])
    })

    it('每个非 off 项都能查到动作', () => {
        const acts = createActions(fakeHost())
        /* 带参数的 act 写成 `名字:参数`，动作表里注册的是那个名字 */
        const missing = items.filter(i => !i.off && i.act && !acts[i.act.split(':')[0]]).map(i => `${i.label}→${i.act}`)
        expect(missing).toEqual([])
    })

    /*
     * 一个动作只能有一个主人，但允许**明写的两个入口**（Typora 就是这样：行内公式在 格式 里、
     * 也在 编辑›数学工具 里）。所以重复必须逐条点名，冒出第三个没登记的重复照样报红。
     */
    it('动作不重复主人（重复的只能是登记过的那两个入口）', () => {
        const TWIN = ['inlineMath', 'mathBlock']
        const on = items.filter(i => !i.off && i.act).map(i => i.act as string)
        const counts = new Map<string, number>()
        for (const a of on) counts.set(a, (counts.get(a) ?? 0) + 1)
        const dup = [...counts].filter(([k, n]) => n > 1)
        expect(dup.map(([k]) => k).sort()).toEqual([...TWIN].sort())
        for (const [, n] of dup) expect(n).toBe(2)
    })

    it('加速键只允许出现在查到出处的那些', () => {
        const bad = items.filter(i => i.accel && !ACCELS_WITH_SOURCE.has(i.accel))
        expect(bad.map(i => `${i.label} ${i.accel}`)).toEqual([])
    })

    /*
     * 画出来的必须和表里的一样多。这条是补上来的：带 sep 的项曾被渲染器整个吞掉
     * （重做 / 全选 / 普通文本 直接从菜单上消失），而上面那几条数据表门禁全绿 ——
     * 因为它查的是表，不是产物。
     */
    it('每一项都真的被画出来，sep 不许吃掉条目', () => {
        const html = menuBarHtml()
        const flat = flatItems(DEFAULT_CTX)
        expect((html.match(/class="mb-item/g) ?? []).length).toBe(flat.length)
        expect((html.match(/class="mb-sep"/g) ?? []).length).toBe(flat.filter(i => i.sep).length)
        expect((html.match(/class="mb-top"/g) ?? []).length).toBe(MENUS.length)
        /* 标签里有 -> 这种字符（智能替换那条就叫「箭头 -> => <-」），比的是转义后的那一串 */
        const esc = (x: string) => x.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
        for (const it of flat) expect(html).toContain(`<span>${esc(it.label)}</span>`)
        for (const it of flat.filter(i => !i.off && i.act))
            expect(html).toContain(`data-act="${it.act}"`)
    })

    /*
     * 有下级的必须带箭头，而且带的是**画出来的图标**，不是 › 这种字符：
     * 字符归字体管，换字体换宽窄、还坐在基线上和 14px 的标签对不齐（他为此骂回来过一次）。
     */
    it('有下级的项画箭头图标，且不和加速键抢同一个槽', () => {
        const html = menuBarHtml()
        const subs = flatItems().filter(i => i.sub || i.dyn)
        expect(subs.length).toBeGreaterThan(0)          /* 扫不到下级项 = 这把尺子自己失效 */
        expect((html.match(/class="mb-arrow"/g) ?? []).length).toBe(subs.length)
        for (const it of subs)
            expect(html).toContain(`<span>${it.label}</span><span class="mb-arrow"><svg`)
        expect(html).not.toMatch(/class="mb-arrow">[^<]/)   /* 槽里不许塞裸字符 */
        expect(flatItems().filter(i => (i.sub || i.dyn) && i.accel).map(i => i.label)).toEqual([])
        /* 反证：抹掉一项的 sub，箭头数必须跟着少一个（不是恒等于表里的数） */
        const one = subs[0].label
        const stripped = html.replace(`<span>${one}</span><span class="mb-arrow"><svg`,
            `<span>${one}</span><span class="mb-accel"></span><span class="x"><svg`)
        expect((stripped.match(/class="mb-arrow"/g) ?? []).length).toBe(subs.length - 1)
    })
})

/* 在真内核上跑：改完必须还能逐字节往返。假宿主两个 describe 共用 */
function apply(src: string, act: string, sel?: [number, number], run?: (h: Host) => void): string {
    const c = openChunked(src)
    const bs = blocks(c)
    const target = bs[0]
    let out = src
    const h: Host = {
        text: src,
        blockNode: target.node,
        blockRange: { start: target.start, end: target.end },
        selection: sel ? { start: sel[0], end: sel[1] } : null,
        renderedHtml: () => '',
        splice: (f, t, ins) => { out = out.slice(0, f) + ins + out.slice(t)
            /* main.ts 的宿主每次动作都从当前状态现取文本；这里的 h.text 是开头拍快照，
             * 一个动作里连着两次改动（脚注先插正文、再追定义）必须读得到第一次的结果 */
            h.text = out },
        replaceAll: t => { out = t; h.text = out },
        afterBlock: ins => { out = out.slice(0, target.end) + '\n' + ins + out.slice(target.end); h.text = out },
        atDocStart: ins => { out = ins + out; h.text = out },
        /* 和 buildHost 同一条规则：插到内容末尾（尾随换行之前），不是字符串末尾 */
        atDocEnd: ins => { const e = out.length - (/\n*$/.exec(out) ?? [''])[0].length
            out = out.slice(0, e) + ins + out.slice(e); h.text = out },
        undo() {}, redo() {}, fileNew() {}, fileOpen() {}, fileOpenDir() {}, save() {},
        saveAs() {}, exportHtmlFile() {}, print() {}, newWindow() {}, copy() {},
        toggle() {}, fullscreen() {}, zoom() {}, theme() {}, findPanel() {},
        selectAll() {}, paste() {}, closeDoc() {}, revert() {}, speak() {},
        spellcheck() {}, lineEnding() {}, jumpTo() {},
        reopenEncoding() {}, openRecent() {}, quickOpen() {}, duplicate() {},
        rename() {}, moveToDir() {}, importFile() {},
        newTab() {}, switchDocs() {}, articles() {}, help() {},
        imageMode() {}, imageProps() {}, substitution() {}, pageSetup() {},
    }
    if (run) run(h); else createActions(h)[act]?.()
    return out
}

describe('段落与格式动作真的改源码', () => {
    const cases: [string, string][] = [
        ['h2', '## 段落 文字\n'],
        ['paragraph', '段落 文字\n'],
        ['quote', '> 段落 文字\n'],
        ['ul', '- 段落 文字\n'],
        ['ol', '1. 段落 文字\n'],
        ['task', '- [ ] 段落 文字\n'],
        ['codeFence', '```\n段落 文字\n```\n'],
        ['strong', '**段落 文字**\n'],
        ['emphasis', '*段落 文字*\n'],
        ['strike', '~~段落 文字~~\n'],
        ['code', '`段落 文字`\n'],
    ]
    for (const [act, want] of cases) {
        it(`${act} → ${JSON.stringify(want)}`, () => {
            const out = apply('段落 文字\n', act)
            expect(out).toBe(want)
            expect(serializeChunked(openChunked(out))).toBe(out)      /* 改完仍然逐字节可往返 */
        })
    }

    /*
     * B 批：高亮/上标/下标/注释。这四条不自造语法 —— 插的是 HTML 标签（Typora 也是），
     * 别的 Markdown 工具读得回去，内核也不用加构造。注释用标准 HTML 注释，
     * Typora 那个 %%..%% 是它自造的，要走内核扩展才做得成，代价另说。
     */
    const htmlCases: [string, string][] = [
        ['highlight', '<mark>段落 文字</mark>\n'],
        ['superscript', '<sup>段落 文字</sup>\n'],
        ['subscript', '<sub>段落 文字</sub>\n'],
        ['comment', '<!-- 段落 文字 -->\n'],
    ]
    for (const [act, want] of htmlCases) {
        it(`${act} → ${JSON.stringify(want)}`, () => {
            const out = apply('段落 文字\n', act)
            expect(out).toBe(want)
            expect(serializeChunked(openChunked(out))).toBe(out)
        })
    }
    it('这四条也只包选区，不吞整块', () => {
        expect(apply('段落 文字\n', 'highlight', [3, 5])).toBe('段落 <mark>文字</mark>\n')
        expect(apply('段落 文字\n', 'comment', [3, 5])).toBe('段落 <!-- 文字 -->\n')
    })
    it('反证：这四条不再是 off，也不在 NOT_DONE 里', () => {
        for (const a of ['highlight', 'superscript', 'subscript', 'comment']) {
            expect(NOT_DONE).not.toContain(a)
            expect(allItems().find(i => i.act === a)?.off).toBeFalsy()
        }
    })

    it('有选区时只包选区，不吞整块', () => {
        /* 段落 文字 → 「文字」被选中（偏移 3..5） */
        expect(apply('段落 文字\n', 'strong', [3, 5])).toBe('段落 **文字**\n')
    })

    /*
     * 这四条以前是灰的（Typora 有、我们没有）：列表缩进 / 列表退格 / 链接引用 / 脚注。
     * 判据写在这里而不是"点了没报错"：缩进必须只动光标那一行、退格必须能回到原文、
     * 引用式不许碰图片、脚注必须正文和文末各动一处。
     */
    it('列表缩进只动光标那一行，别的一项不跟着走', () => {
        const out = apply('- a\n- b\n', 'indent', [4, 4])
        expect(out).toBe('- a\n  - b\n')
        expect(serializeChunked(openChunked(out))).toBe(out)
    })

    /* 从菜单点的那条路：mousedown 先把编辑框提交掉，选区跟着没了 —— 没有选区时整块都得动，
     * 不能变成"点了没反应" */
    it('没有选区（走菜单点的）时整块每一项都缩', () => {
        const out = apply('- a\n- b\n', 'indent')
        expect(out).toBe('  - a\n  - b\n')
        expect(serializeChunked(openChunked(out))).toBe(out)
        /* 退格要能回到原文：区间抬到行首，第一项那两个空格才退得掉 */
        const back = apply(out, 'outdent')
        expect(back).toBe('- a\n- b\n')
        expect(serializeChunked(openChunked(back))).toBe(back)
    })

    it('缩进再退格回到原文；选区跨两项时两项一起缩', () => {
        expect(apply(apply('- a\n- b\n', 'indent', [4, 4]), 'outdent', [6, 6])).toBe('- a\n- b\n')
        expect(apply('- a\n- b\n', 'indent', [2, 6])).toBe('  - a\n  - b\n')
    })

    it('链接引用：行内链接改成引用式，定义补在下面，图片不动', () => {
        const out = apply('看 [官网](https://ty.io) 吧\n', 'linkReference')
        expect(out).toBe('看 [官网][1] 吧\n\n[1]: https://ty.io\n')
        expect(serializeChunked(openChunked(out))).toBe(out)
        const r = toReference('![图](a.png) 和 [链](b.io)')
        expect(r.body).toBe('![图](a.png) 和 [链][1]')
        expect(r.defs).toEqual(['[1]: b.io'])
        expect(toReference('[文](u "题")', 3).defs).toEqual(['[3]: u "题"'])
    })

    it('这一行没有行内链接时，整行做成一个引用式（点了必须有反应）', () => {
        expect(apply('官网\n', 'linkReference')).toBe('[官网][1]\n\n[1]: https://\n')
    })

    it('脚注：正文插引用、文末开定义，连点两次编号递增', () => {
        const one = apply('正文\n', 'footnotes')
        expect(one).toBe('正文[^1]\n\n[^1]: \n')
        expect(serializeChunked(openChunked(one))).toBe(one)
        const two = apply(one, 'footnotes')
        expect(two).toBe('正文[^1][^2]\n\n[^1]: \n\n[^2]: \n')
        expect(nextFootnote(two)).toBe(3)
    })

    /* 定义以前直接拼在字符串末尾，文档自带的那个尾随换行留在中间 = 多出一个空块 */
    it('正文和定义之间恰好一个空行，不许连出三个换行', () => {
        for (const out of [apply('正文\n', 'footnotes'), apply('前面 要挪走 后面\n', 'footnotes', [3, 6]),
            apply('看 [官网](https://ty.io) 吧\n', 'linkReference')]) {
            expect(out).not.toMatch(/\n{3,}/)
            expect(out.endsWith('\n')).toBe(true)     /* 尾随换行还在原位，只是挪到了最后一条定义后面 */
        }
    })

    it('脚注：选中一段时，那段搬进定义，正文只留引用', () => {
        const out = apply('前面 要挪走 后面\n', 'footnotes', [3, 6])
        expect(out).toBe('前面 [^1] 后面\n\n[^1]: 要挪走\n')
        expect(serializeChunked(openChunked(out))).toBe(out)
    })

    it('标号取的是没用过的那个号', () => {
        expect(nextRefId('[1]: a\n[2]: b\n')).toBe(3)
        expect(nextFootnote('[^1]: x\n[^2]: y\n')).toBe(3)
        expect(nextFootnote('[^a]: x\n')).toBe(1)      /* 字母标号不占数字号 */
    })

    it('反证：这四条不再是 off 项，也不在 NOT_DONE 里', () => {
        for (const a of ['indent', 'outdent', 'linkReference', 'footnotes']) {
            expect(NOT_DONE).not.toContain(a)
            expect(allItems().find(i => i.act === a)?.off).toBeFalsy()
        }
    })
    it('表格 / 水平线 / 目录 / YAML 是插入，不毁掉原块', () => {
        for (const act of ['table', 'hr', 'toc']) {
            const out = apply('段落 文字\n', act)
            expect(out.startsWith('段落 文字\n')).toBe(true)
            expect(serializeChunked(openChunked(out))).toBe(out)
        }
        expect(apply('段落 文字\n', 'yaml')).toBe('---\n---\n段落 文字\n')
    })

    it('多级标题的目录按级别缩进', () => {
        expect(tocOf('# 一\n\n## 二\n\n### 三\n')).toBe('- 一\n  - 二\n    - 三')
    })

    it('inlineSource 拿的是行内源码，块标记不掺进来', () => {
        const t = parse('段落 **粗** 和 `码`\n').root.children[0]
        expect(inlineSource(t)).toBe('段落 **粗** 和 `码`')
        const q = parse('> 引用\n').root.children[0]
        expect(inlineSource(q)).toBe('引用')
    })
})

/*
 * A 批（他说"这些没有做的都做了"那一批里的第一批）：全是纯文本/选区能表达的，
 * 所以判据都能写在 Node 里 —— 复制的内容、粘贴的落点、清了格式后一个字不许少、
 * 换行符只动写盘那一份。
 */
describe('A 批：复制 剪切 粘贴 全选 清除格式 换行符 跳到', () => {
    it('清除格式：记号剥掉，字一个不少', () => {
        const t = parse('段落 **粗** 和 `码` 与 [官网](https://ty.io)\n').root.children[0]
        expect(clearInline(t)).toBe('段落 粗 和 码 与 官网')
        const img = parse('看 ![猫](cat.png)\n').root.children[0]
        expect(clearInline(img)).toBe('看 猫')
        /* 拆不出来的写法（引用式图片）整段留着，不许当成"没有文字"抹掉 */
        const ref = parse('看 ![猫][1]\n').root.children[0]
        expect(clearInline(ref)).toBe('看 ![猫][1]')
    })

    it('清除格式认不出的类型原样留着 —— 宁可某一种没清掉，也不许把字吃掉', () => {
        const t = parse('前 ~~删~~ 后\n').root.children[0]
        expect(clearInline(t)).toContain('后')
        expect(clearInline(t)).toContain('删')
    })

    it('targetText：有选区取选区，没选区取整块源码', () => {
        const h = (sel: [number, number] | null): Host => ({
            ...({} as Host), text: '段落 **粗**\n', selection: sel ? { start: sel[0], end: sel[1] } : null,
            blockNode: parse('段落 **粗**\n').root.children[0], blockRange: { start: 0, end: 10 },
        })
        expect(targetText(h([3, 6]))).toBe('**粗')
        expect(targetText(h(null))).toBe('段落 **粗**')
    })

    it('粘贴落在光标处；无格式粘贴把记号按字面量贴进去', () => {
        const rich = apply('段落\n', '', [2, 2], h => insertText(h, 'a **b**', false))
        expect(rich).toBe('段落a **b**\n')
        const plain = apply('段落\n', '', [2, 2], h => insertText(h, 'a **b**', true))
        expect(plain).toBe('段落a \\*\\*b\\*\\*\n')
        expect(serializeChunked(openChunked(plain))).toBe(plain)
    })

    it('贴进块里不许把整段吞掉：换行折成空格，两头不留换行变出来的空白', () => {
        expect(apply('段落\n', '', [2, 2], h => insertText(h, '一\n\n二', false))).toBe('段落一 二\n')
        expect(apply('段落\n', '', undefined, h => insertText(h, '新的一块\n', false))).toBe('段落新的一块\n')
    })

    it('换行符只动写盘那一份，内存里永远是 \\n', () => {
        expect(toEol('a\nb\n', 'crlf')).toBe('a\r\nb\r\n')
        expect(toEol('a\r\nb\n', 'lf')).toBe('a\nb\n')
        expect(toEol('a\nb', 'cr')).toBe('a\rb')
        expect(toEol('a\nb', 'lf')).toBe('a\nb')
    })

    it('跳到用的标题清单带级别和位置', () => {
        const hs = headings('# 一\n\n## 二\n\n正文\n\n### 三\n')
        expect(hs.map(x => [x.level, x.title, x.at])).toEqual([[1, '一', 0], [2, '二', 5], [3, '三', 15]])
    })

    it('带参数的 act（jumpTo:2 / lineEnding:crlf）查得到动作并收得到参数', () => {
        const log: string[] = []
        const acts = createActions({
            ...({} as Host), text: '', blockNode: null, blockRange: null, selection: null,
            jumpTo: i => log.push(`jump ${i}`), lineEnding: e => log.push(`eol ${e}`),
        })
        acts.jumpTo?.('2')
        acts.lineEnding?.('crlf')
        acts.lineEnding?.(undefined)      /* 参数丢了也要落在一个确定的档上 */
        expect(log).toEqual(['jump 2', 'eol crlf', 'eol lf'])
    })

    it('反证：A 批这十项不再是 off，也不在 NOT_DONE 里', () => {
        for (const a of ['cut', 'copy', 'paste', 'pastePlain', 'selectAll', 'clearFormat',
            'close', 'revertTo', 'spelling', 'speech']) {
            expect(NOT_DONE).not.toContain(a)
            expect(allItems().find(i => i.act === a)?.off).toBeFalsy()
        }
        expect(allItems().find(i => i.label === '换行符')?.off).toBeFalsy()
        expect(allItems().find(i => i.label === '跳到')?.dyn).toBeTypeOf('function')
    })

    /*
     * 这个壳里一个原生弹窗都不许有：底色字号按钮文案全归操作系统，四套皮一套都不跟，
     * 而且在 --app 窗口里是横在屏幕中间的一坨系统灰。要问一句就走自绘的 askBox。
     */
    it('不许出现原生 confirm / alert / prompt', () => {
        const app = readFileSync('src/app/main.ts', 'utf8')
        expect(app).not.toMatch(/\b(?:window\.)?confirm\(/)
        expect(app).not.toMatch(/\balert\(/)
        expect(app).not.toMatch(/\bprompt\(/)
        expect(app).toMatch(/function askBox\(o: AskOpts\)/)
    })

    /* dyn 项（跳到 = 标题清单）只在开菜单那一刻重画，开机画一次就会永远停在第一篇的标题上 */
    it('打开顶层菜单必然先重画菜单条', () => {
        const app = readFileSync('src/app/main.ts', 'utf8')
        const f = /function openMenu\(i: number\)[\s\S]*?\n}/.exec(app)?.[0] ?? ''
        expect(f).not.toBe('')
        expect(f).toMatch(/innerHTML = menuBarHtml\(menuCtx\(\)\)/)
        expect(f).toMatch(/classList\.add\('on'\)/)
        /* 开菜单的三条路径都必须走 openMenu；`openTop =` 只该出现在声明、closeMenus、openMenu 三处 */
        expect((app.match(/openTop = /g) ?? [])).toHaveLength(3)
    })
})

/*
 * C 批（文件类）：规则是纯的，所以判据全在 Node 里 —— 副本怎么让号、最近列表怎么留、
 * 快速打开怎么过滤、HTML 折成 Markdown 时结构留没留下。真句柄那半边在浏览器里量。
 */
describe('C 批：副本名 最近列表 快速打开 导入', () => {
    it('副本名往后让号，扩展名留住', () => {
        expect(nextCopyName('a.md', [])).toBe('a 副本.md')
        expect(nextCopyName('a.md', ['a 副本.md'])).toBe('a 副本 2.md')
        expect(nextCopyName('a.md', ['a 副本.md', 'a 副本 2.md'])).toBe('a 副本 3.md')
        expect(nextCopyName('README', [])).toBe('README 副本')
    })
    it('最近列表：新的排最前、同名去重、截到 8 条', () => {
        expect(pushRecent(['b.md', 'a.md'], 'a.md')).toEqual(['a.md', 'b.md'])
        expect(pushRecent([], 'x.md')).toEqual(['x.md'])
        const many = Array.from({ length: 12 }, (_, i) => `f${i}.md`)
        expect(pushRecent(many, 'new.md')).toHaveLength(8)
        expect(pushRecent(many, 'new.md')[0]).toBe('new.md')
    })
    it('快速打开：不分大小写的子串命中，最多 12 条', () => {
        const fs = ['Readme.md', 'notes/a.md', 'notes/B.md', 'c.md']
        expect(filterFiles(fs, 'b')).toEqual(['notes/B.md'])
        expect(filterFiles(fs, '')).toHaveLength(4)
        expect(filterFiles(fs, '不存在的')).toEqual([])
        expect(filterFiles(Array.from({ length: 40 }, (_, i) => `f${i}.md`), 'f')).toHaveLength(12)
    })
    it('导入 HTML：结构留下、脚本样式注释剥掉、实体只解一层', () => {
        const NL = String.fromCharCode(10)      /* 换行用现成的串拼，免得在转义上栽第二次 */
        expect(htmlToMd('<h2>标</h2><p>文 &amp; 字</p>')).toBe('## 标' + NL + '文 & 字' + NL)
        expect(htmlToMd('<style>a{}</style><script>x</script><!-- c --><p>b</p>')).toBe('b' + NL)
        expect(htmlToMd('<p>&amp;lt;</p>')).toBe('&lt;' + NL)
        expect(htmlToMd('<ul><li>一</li><li>二</li></ul>')).toContain('- 一')
    })
    it('反证：这七项不再是 off', () => {
        for (const a of ['reopenWithEncoding', 'openRecent', 'quickOpen', 'duplicate', 'rename', 'moveTo', 'import']) {
            expect(NOT_DONE).not.toContain(a)
            expect(allItems().find(i => i.act === a)?.off).toBeFalsy()
        }
    })
    it('编码子菜单就是 ENCODINGS 那一行，两边不许各说一套', () => {
        const html = menuBarHtml()
        for (const [code, label] of ENCODINGS) {
            expect(html).toContain(`<span>${label}</span>`)
            expect(html).toContain(`data-act="reopenWithEncoding:${code}"`)
        }
    })
    it('最近文件按现场画：有记录才有项', () => {
        const ctx = { ...DEFAULT_CTX, recents: ['甲.md', '乙.md'] }
        const html = menuBarHtml(ctx)
        expect(html).toContain('data-act="openRecent:0"')
        expect(html).toContain('data-act="openRecent:1"')
        expect(menuBarHtml(DEFAULT_CTX)).not.toContain('data-act="openRecent:')
    })
    /* 加速键撞车 = 后注册的那个吃掉前一个，前者当场变成死键（快速打开和打印就撞过） */
    it('活项的加速键不许撞车', () => {
        const seen = new Map<string, string>()
        const dup: string[] = []
        for (const it of flatItems(DEFAULT_CTX)) {
            if (!it.accel || it.off || !it.act) continue
            const k = it.accel.toLowerCase().replace(/\s+/g, '')
            if (seen.has(k)) dup.push(`${it.label} ${it.accel} 撞了 ${seen.get(k)}`)
            seen.set(k, it.label)
        }
        expect(dup).toEqual([])
    })
})

/*
 * D 批：标签、文章列表、帮助。标签的缓冲逻辑活在 main.ts（要 DOM），这里量三件能纯算的：
 * 平铺顺序、来路前缀、以及帮助页和菜单表不许分家。
 */
describe('D 批：文章列表顺序 帮助页', () => {
    it('文章列表按文章名排，data-f 仍指回原下标', () => {
        const files = [{ name: 'b.md', path: 'notes/b.md' }, { name: 'a.md', path: 'x/a.md' }, { name: 'c.md', path: 'c.md' }]
        expect(articleOrder(files)).toEqual([1, 0, 2])
        /* 同名不同目录：按来路再排一次，顺序必须稳定（不然每次打开看到的清单会跳） */
        const same = [{ name: 'a.md', path: 'z/a.md' }, { name: 'a.md', path: 'a/a.md' }]
        expect(articleOrder(same)).toEqual([1, 0])
    })
    it('来路前缀：根目录下的文章不缀东西', () => {
        expect(folderOf('notes/a.md')).toBe('notes/')
        expect(folderOf('a.md')).toBe('')
    })
    it('帮助页从菜单表现算：每条带加速键的活项都在上面', () => {
        const html = helpHtml(DEFAULT_CTX)
        for (const it of flatItems(DEFAULT_CTX).filter(i => !i.off && i.accel && !i.dyn)) {
            expect(html).toContain(`<span>${it.label}</span><kbd>${it.accel}</kbd>`)
        }
        expect(html).toContain('<kbd>Ctrl+B</kbd>')
    })
    it('帮助页也列出做不到的那些，并带上原因', () => {
        const html = helpHtml(DEFAULT_CTX)
        expect(html).toContain('打开文件位置 —— 浏览器不允许网页去开资源管理器')
        expect(html).toContain('总是置顶 —— 网页管不了窗口层级，浏览器没有这个接口')
    })
    it('反证：D 批这四项不再是 off', () => {
        for (const a of ['newTab', 'switchDocs', 'articles', 'help']) {
            expect(NOT_DONE).not.toContain(a)
            expect(allItems().find(i => i.act === a)?.off).toBeFalsy()
        }
    })
    it('切换文档的子菜单按现场画，当前那一篇带点', () => {
        const ctx = { ...DEFAULT_CTX, docs: [{ name: '甲.md', dirty: false }, { name: '乙.md', dirty: true }], docAt: 1 }
        const html = menuBarHtml(ctx)
        expect(html).toContain('● 乙.md')
        expect(html).toContain('甲.md')
        expect(html).toContain('data-act="switchDocs:0"')
        expect(html).toContain('未保存')
        expect(menuBarHtml(DEFAULT_CTX)).not.toContain('data-act="switchDocs:')
    })
    /* 标签栏只许 renderDoctabs 一个人画；角标隐藏必须用 visibility（opacity:0 还点得着=死控件） */
    it('标签栏一处 owner，关的那颗角标隐藏时点不着', () => {
        const app = readFileSync('src/app/main.ts', 'utf8')
        const css = readFileSync('src/styles/theme.css', 'utf8')
        const html = readFileSync('app/index.html', 'utf8')
        expect(html).toContain('<div id="doctabs"></div>')
        expect((app.match(/dt-list/g) ?? [])).toHaveLength(1)   /* 这套标记只有 renderDoctabs 发 */
        expect(app).toMatch(/function renderDoctabs\(\)[\s\S]*?innerHTML/)
        expect(css).toMatch(/\.dt-x \{[^}]*visibility: hidden/)
        expect(css).not.toMatch(/\.dt-x \{[^}]*opacity: 0/)
    })
})

/*
 * E 批：智能替换与页面。两条最容易错的地方都有判据：--- 必须先把三横的那条吃掉
 * （否则剩下 - 拼出个错字符），@page 的数值只能现拼（Chrome 的 @page 里不认 var()）。
 */
describe('E 批：替换表 页面设置', () => {
    it('一条都没开就原样返回；开了才换', () => {
        expect(substitute('(c) a--b 1...2', [])).toBe('(c) a--b 1...2')
        expect(substitute('(c) 公司', ['symbols'])).toBe('© 公司')
    })
    it('三横先换，不然 --- 会被 -- 拆成 –-', () => {
        expect(substitute('a---b', ['dash'])).toBe('a—b')
        expect(substitute('a--b', ['dash'])).toBe('a–b')
    })
    it('省略号与箭头', () => {
        expect(substitute('等等... 走 -> 回 <-', ['ellipsis', 'arrows'])).toBe('等等… 走 → 回 ←')
    })
    it('直引号不在表里：那个双引号是定义与属性的定界符，动它就是在动语法', () => {
        const all = SUBRULES.flatMap(r => r.pairs.map(x => x[0]))
        /* 引号是定义与属性的定界符（[a]: u "题"），动它就是在动语法 —— 表里不许有它 */
        expect(all.filter(x => x.includes('"') || x.includes("'"))).toEqual([])
    })
    it('@page 现拼：认得的纸给尺寸，认不出的只写边距', () => {
        expect(pageCss({ size: 'A4', margin: [18, 16, 18, 16] }))
            .toBe('@page { size: 210mm 297mm; margin: 18mm 16mm 18mm 16mm; }')
        expect(pageCss({ size: 'Letter', margin: [10, 10, 10, 10] })).toContain('size: 215.9mm 279.4mm')
        expect(pageCss({ size: '怪纸', margin: [1, 2, 3, 4] })).toBe('@page { margin: 1mm 2mm 3mm 4mm; }')
    })
    it('图片工具与数学工具的子菜单都有动作', () => {
        const tools = allItems().find(i => i.label === '图片工具')
        expect(tools?.off).toBeFalsy()
        expect((tools?.sub ?? []).map(x => x.act)).toEqual(['imageNatural', 'imageFit', 'imageProps'])
        const math = allItems().find(i => i.label === '数学工具')
        expect(math?.off).toBeFalsy()
        expect((math?.sub ?? []).every(x => !x.off)).toBe(true)
        expect((math?.sub ?? []).map(x => x.act)).toEqual(['inlineMath', 'mathBlock'])
    })
    it('替换子菜单把开着的规则带点画出来', () => {
        const ctx = { ...DEFAULT_CTX, subs: ['dash'] }
        const html = menuBarHtml(ctx)
        expect(html).toContain('● 破折号 -- 和 ---')
        expect(html).toContain('data-act="substitution:dash"')
        expect(html).toContain('data-act="substitution:symbols"')
        expect(html).not.toContain('● 符号')
    })
    it('当前档位带选中色，且悬停仍然压得住它', () => {
        const html = menuBarHtml({ ...DEFAULT_CTX, on: ['imageNatural', 'lineEnding:crlf'] })
        expect(html).toContain('<div class="mb-item sel" data-act="imageNatural"')
        expect(html).toContain('<div class="mb-item sel" data-act="lineEnding:crlf"')
        expect(html).not.toContain('<div class="mb-item sel" data-act="imageFit"')
        const css = readFileSync('src/styles/theme.css', 'utf8')
        /* 比的是规则，不是散文：CSS 注释里也提到 .mb-item:hover，不带 ' {' */
        expect(css.indexOf('.mb-item.sel {')).toBeLessThan(css.indexOf('.mb-item:hover {'))
        expect(css).toMatch(/\.mb-item\.sel \{ color: var\(--accent\); \}/)
    })
    it('反证：这四项不再是 off', () => {
        for (const a of ['substitutions', 'mathTools', 'imageTools', 'pageSetup']) expect(NOT_DONE).not.toContain(a)
        for (const l of ['替换', '数学工具', '图片工具', '页面设置'])
            expect(allItems().find(i => i.label === l)?.off).toBeFalsy()
    })
})

/*
 * 加速键链路的两处命门都只活在 main.ts 里（Node 里既没有键盘也没有 textarea），所以按源码钉。
 * 少任何一条，"列表缩进"就退化成只有从菜单点才管用的那个东西。
 */
describe('编辑框里的加速键链路', () => {
    const app = readFileSync('src/app/main.ts', 'utf8')
    it('宿主读选区时接住了编辑框里的那一份', () => {
        expect(app).toMatch(/selection: selectionRange\(\) \?\? editorSelection\(\) \?\? lastCaretInBlock\(\)/)
    })
    /* 真点菜单的那一下会先把编辑框提交掉，焦点跟着没了：光标得由 commit 记下来，
     * 否则"只动一行"的动作没人指哪一行，整组列表会跟着一起缩 */
    it('提交时记下光标，换篇/撤销时收回', () => {
        const commit = /function commit\(ta: HTMLTextAreaElement\)[\s\S]*?\n}/.exec(app)?.[0] ?? ''
        expect(commit).not.toBe('')
        expect(commit).toMatch(/state\.lastCaret = from \+ Math\.min\(ta\.selectionStart, val\.length\)/)
        const caret = /function lastCaretInBlock[\s\S]*?\n}/.exec(app)?.[0] ?? ''
        expect(caret).toMatch(/c < cur\.start \|\| c > cur\.end/)   /* 不在当前块里就宁可不认 */
        expect((app.match(/state\.lastCaret = null/g) ?? [])).toHaveLength(2)   /* load 和 undo */
    })
    it('光标换算用框自己的 data-s，并且夹在 data-e 以内', () => {
        const f = /function editorSelection[\s\S]*?\n}/.exec(app)?.[0] ?? ''
        expect(f).not.toBe('')                                   /* 扫不到 = 门禁自己失效 */
        expect(f).toMatch(/Number\(ta\.dataset\.s\)/)
        expect(f).toMatch(/Math\.min\(end, base \+ ta\.selectionStart\)/)
    })
    it('Ctrl+[ 与 Ctrl+] 在编辑框聚焦时照样执行，其余按键照旧让给浏览器', () => {
        expect(app).toMatch(/const IN_EDITOR = new Set\(\['indent', 'outdent'\]\)/)
        expect(app).toMatch(/if \(id && \(!inEditor \|\| IN_EDITOR\.has\(id\)\)/)
    })
    it('反证：那条一刀切的"编辑框里一律不抢"必须已经没了', () => {
        expect(app).not.toMatch(/if \(id && !inEditor\) \{/)
    })
    /*
     * 动作走的是宿主自己的 splice，不经过 commit()。commit 收尾会把 state.editing 收回 -1，
     * 动作那两条如果照样留着，render 就给那块刷上 md-editing、却发不出编辑框
     * （区间已经挪走），于是那块从此点不动 —— 菜单点一次，废掉一块。
     */
    it('改文本的宿主方法必须自己关掉编辑态', () => {
        const mutators = app.match(/(?:^| )(?:splice|replaceAll): [^\n]*\}/gm) ?? []
        expect(mutators).toHaveLength(2)
        for (const m of mutators) expect(m).toContain('state.editing = -1')
        const undo = /function step\(dir: number\)[\s\S]*?\n}/.exec(app)?.[0] ?? ''
        expect(undo).not.toBe('')
        expect(undo).toContain('state.editRange = null')
    })
})

/* 反证：把动作表里的一项删掉，"每个非 off 项都能查到动作"必须变红 */
describe('门禁能分辨', () => {
    it('少一个动作就报出来', () => {
        const h = { ...{} as unknown as Host }
        const acts = createActions(h)
        expect(acts.h2).toBeTypeOf('function')
        delete acts.h2
        const items = allItems().filter(i => !i.off && i.act)
        expect(items.some(i => !acts[i.act as string])).toBe(true)
    })

    it('区间与内核同源：块的 start/end 直接来自 blocks()', () => {
        const src = '# t\n\n段落 **粗**\n'
        const c = openChunked(src)
        const bs = blocks(c)
        /* 块区间本身不含尾随换行（那道换行归 root.close） */
        expect(c.text.slice(bs[1].start, bs[1].end)).toBe('段落 **粗**')
        expect(span(chunkedRoot(c), 0).kids.length).toBe(bs.length)
    })
})

/*
 * 侧栏做成 tab 之后，"哪一页可见"变成一个**状态**（state.sideTab），而状态只能有一个主人。
 * 以前是菜单里的「大纲」「文件目录树」各自 classList.toggle('hide')，和标题各切各的，
 * 两处能同时把两页都藏起来（那就是一块空白）。这几条把"只有一个主人"钉住。
 */
describe('侧栏两页只有一个主人', () => {
    const html = readFileSync('app/index.html', 'utf8')
    const app = readFileSync('src/app/main.ts', 'utf8')
    const found = /function setSideTab[\s\S]*?\n}/.exec(app)
    const body = found ? found[0] : ''
    const hideOwners = (s: string) => s.split('\n').filter(l => /'(tree|toc|hits)'/.test(l) && /hide/.test(l))
    /* 先钉住"确实扫到了这个函数"：扫不到就一条测试都不会生成，等于门禁自己失效 */
    it('setSideTab 在 main.ts 里找得到', () => {
        expect(body).not.toBe('')
    })
    it('页签正好两个：文件 / 大纲', () => {
        expect([...html.matchAll(/data-tab="(\w+)"/g)].map(m => m[1])).toEqual(['file', 'toc'])
    })
    it('三块面板的显隐只写在 setSideTab 里，别处一处都没有', () => {
        expect(hideOwners(body)).toHaveLength(3)
        expect(hideOwners(app.replace(body, ''))).toEqual([])
    })
    it('反证：别处再偷偷藏一块，这条要报红', () => {
        const rest = app.replace(body, '')
        expect(hideOwners(rest + "\n    $('toc').classList.add('hide')\n")).toHaveLength(1)
    })
    it('菜单那两条的入口还在，且落到同一个状态上', () => {
        expect(allItems().filter(i => ['outline', 'fileTree'].includes(i.act as string)).map(i => i.act))
            .toEqual(['outline', 'fileTree'])
        expect(/outline: \(\) => \{ setSideTab\('toc'\)/.test(app)).toBe(true)
        expect(/fileTree: \(\) => \{\s*setSideTab\('file'\)/.test(app)).toBe(true)
    })
})
