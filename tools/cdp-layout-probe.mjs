import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * 版式探针：两行引用在预览里占几行、点下去高度跳多少。
 * 内嵌那个浏览器视口是 0×0，量不了换行 —— 这里自起一次性 headless Chrome（1280×900），
 * 用真鼠标事件进编辑态，别用合成事件（合成点击不产生用户手势，也不走焦点那套）。
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = Number(process.env.PROBE_PORT ?? 9345)
const work = mkdtempSync(join(tmpdir(), 'mdkit-layout-'))
const APP = 'file:///' + join(process.cwd(), 'app/index.html').replace(/\\/g, '/')

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'p')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', APP,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let ws
const pending = new Map()
let id = 0
function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const n = ++id
        pending.set(n, { resolve, reject })
        ws.send(JSON.stringify({ id: n, method, params }))
    })
}
async function evl(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result.value
}
async function connect() {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
            const pages = (await res.json()).filter(t => t.type === 'page' && /index\.html/.test(t.url))
            if (pages.length) {
                ws = new WebSocket(pages[0].webSocketDebuggerUrl)
                await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
                ws.onmessage = m => {
                    const msg = JSON.parse(m.data)
                    if (msg.id && pending.has(msg.id)) {
                        const p = pending.get(msg.id); pending.delete(msg.id)
                        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
                    }
                }
                return
            }
        } catch { /* 还没起来 */ }
        await sleep(400)
    }
    throw new Error('CDP 连不上')
}

/* 每一块：预览占几行 / 预览多高 / 进编辑后多高 —— 差就是"点下去跳一行"的那个数 */
const SWEEP = `(async () => {
    const P = window.__mdkit
    P.load(P.demo, '演示文档.md', null)
    await new Promise(r => requestAnimationFrame(r))
    const write = document.getElementById('write')
    const n = P.blocks().length
    const rows = []
    for (let i = 0; i < n; i++) {
        P.load(P.demo, '演示文档.md', null)
        const bs = [...write.querySelectorAll(':scope > .md-block')]
        const b = bs[i]
        const tops = (el) => new Set([...el.getClientRects()].map(x => Math.round(x.top))).size
        const previewLines = Math.max(1, ...[...b.querySelectorAll('.md-text')].map(t => tops(t)).concat([tops(b)]))
        const h0 = +b.getBoundingClientRect().height.toFixed(2)
        const r = b.getBoundingClientRect()
        rows.push({ i, 类型: P.blocks()[i].node.type, 预览行: previewLines, 预览高: h0,
            x: Math.round(r.left + 6), y: Math.round(r.top + Math.min(8, r.height / 2)) })
    }
    return rows
})()`

const MEASURE = `(async () => {
    const NL = String.fromCharCode(10)
    const P = window.__mdkit
    P.load('> 引用两行的 > 号是标记，预览里连位置都不占' + NL + '> 这一样能逐字节存回去' + NL, 'q.md', null)
    await new Promise(r => requestAnimationFrame(r))
    const write = document.getElementById('write')
    const block = write.querySelector('.md-block')
    const texts = [...block.querySelectorAll('.md-text')]
    const lines = (el) => new Set(el.getClientRects().length
        ? [...el.getClientRects()].map(x => Math.round(x.top)) : []).size
    const before = {
        blockH: +block.getBoundingClientRect().height.toFixed(2),
        文本段数: texts.length,
        每段占行: texts.map(t => lines(t)),
        可见行top: [...new Set(texts.flatMap(t => [...t.getClientRects()].map(x => Math.round(x.top))))].sort((a, b) => a - b),
        源码: P.text(),
    }
    const box = texts[0].getBoundingClientRect()
    return { before, click: { x: Math.round(box.left + 4), y: Math.round(box.top + box.height / 2) } }
})()`

const AFTER = `(async () => {
    const write = document.getElementById('write')
    const block = write.querySelector('.md-block')
    const ta = write.querySelector('textarea')
    return {
        还在编辑: !!ta,
        框里几行: ta ? ta.value.split(String.fromCharCode(10)).length : null,
        框高: ta ? +ta.getBoundingClientRect().height.toFixed(2) : null,
        块高: +block.getBoundingClientRect().height.toFixed(2),
    }
})()`

try {
    await connect()
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(600)
    /* SKIP_SWEEP=1：只跑代码块那两段。前面那些探针会自己进编辑态再提交，
     * 想分清"重复提交"是被测代码的问题还是量具留下的状态，就得把它们摘干净再跑 */
    const skip = process.env.SKIP_SWEEP === '1'
    const sweep = skip ? [] : await evl(SWEEP)
    let jump = 0
    if (!skip) for (const row of sweep) {
        for (const type of ['mousePressed', 'mouseReleased'])
            await send('Input.dispatchMouseEvent', { type, x: row.x, y: row.y, button: 'left', clickCount: 1,
                buttons: type === 'mousePressed' ? 1 : 0 })
        await sleep(120)
        const now = await evl(`(() => { const b = document.querySelectorAll('#write > .md-block')[${row.i}]
            return +b.getBoundingClientRect().height.toFixed(2) })()`)
        row.编辑高 = now
        row.跳变 = +(now - row.预览高).toFixed(2)
        if (Math.abs(row.跳变) > 0.5) jump++
        await evl(`(() => { const ta = document.querySelector('#write textarea')
            if (ta) { ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); ta.blur() } return 1 })()`)
        await sleep(60)
    }
    if (!skip) {
        console.log('演示文档逐块：')
        for (const r of sweep) console.log(' ', JSON.stringify({ i: r.i, 类型: r.类型, 预览行: r.预览行, 预览高: r.预览高, 编辑高: r.编辑高, 跳变: r.跳变 }))
        console.log('跳变超过 0.5px 的块数：', jump, '/', sweep.length)
        const m = await evl(MEASURE)
        console.log('两行引用：', JSON.stringify(m.before, null, 1))
        /* 应用自带的两个探针也在真视口下跑一遍（原来只在 0×0 的内嵌页里量） */
        console.log('heightProbe clip 全 0：', await evl('window.__mdkit.heightProbe().every(x => x.clip === 0)'))
        console.log('inlineProbe 全过：', await evl('window.__mdkit.inlineProbe().every(x => x.clipX === 0 && x.clipY === 0 && x.kept)'))
        console.log('源码模式整篇：', await evl('window.__mdkit.sourceProbe().whole'))
    }

    /* 代码块：真点击进编辑 → 框里该只有正文；改一行提交后围栏与语言标一个字不许动 */
    const setup = await evl(`(async () => {
        const NL = String.fromCharCode(10), B = String.fromCharCode(96), F = B + B + B
        const P = window.__mdkit
        P.load(['前', '', F + 'ts', 'let a = 1', F, '', '后'].join(NL) + NL, 'c.md', null)
        await new Promise(r => requestAnimationFrame(r))
        const pre = document.querySelector('#write .md-code-block')
        const r = pre.getBoundingClientRect()
        return { 源码: P.text(), 高: +r.height.toFixed(2), x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, x: setup.x, y: setup.y, button: 'left', clickCount: 1,
            buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(300)
    const box = await evl(`(() => {
        const ta = document.querySelector('#write textarea')
        const b = document.querySelector('#write .md-code-block')
        return { 框里: ta ? ta.value : null, 区间: ta ? [ta.dataset.s, ta.dataset.e] : null,
            含围栏: ta ? ta.value.includes(String.fromCharCode(96)) : null,
            高: b ? +b.getBoundingClientRect().height.toFixed(2) : null }
    })()`)
    console.log('代码块点下去：', JSON.stringify({ 预览高: setup.高, ...box }))
    await evl(`(() => { window.__ev = []
        document.addEventListener('focusout', e => window.__ev.push([e.isTrusted, e.target.tagName,
            e.target.isConnected, e.target.dataset ? e.target.dataset.s : null]), true)
        const ta = document.querySelector('#write textarea')
        ta.value = 'let a = 2' + String.fromCharCode(10) + 'let b = 3'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        /* 只 blur()：让浏览器自己发那一发 focusout。手动 dispatch 一个 focusout 不会移走焦点，
         * 于是提交后 DOM 一换，浏览器还会再补一发 —— 同一区间被提交两次。
         * 那是量具造出来的状态，真用户做不出"焦点没走却先收到 focusout" */
        ta.blur(); return 1 })()`)
    await sleep(200)
    console.log('focusout 到了几次：', JSON.stringify(await evl('window.__ev')))
    console.log('改完提交（合成事件）：', await evl(`(() => { const P = window.__mdkit
        return { 源码: JSON.stringify(P.text()), 往返: P.serialize() === P.text() } })()`))

    /* 同一件事再走一遍**真**路径：真点击进块 → 真键盘敲字 → 真点击别处提交。
     * 合成 focusout 那套只算一条辅助路，别拿它当用户行为（这次就是它先暴露了重复提交） */
    const key = async (k, code, text) => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: code === 'Enter' ? 13 : 65, text })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: code === 'Enter' ? 13 : 65 })
    }
    const setup2 = await evl(`(async () => {
        const NL = String.fromCharCode(10), B = String.fromCharCode(96), F = B + B + B
        const P = window.__mdkit
        P.load(['前', '', F + 'ts', 'let a = 1', F, '', '后'].join(NL) + NL, 'c.md', null)
        await new Promise(r => requestAnimationFrame(r))
        const pre = document.querySelector('#write .md-code-block')
        const r = pre.getBoundingClientRect()
        const tail = document.querySelector('#write .md-block:last-child')
        const t = tail.getBoundingClientRect()
        return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2),
            tx: Math.round(t.left + 6), ty: Math.round(t.top + t.height / 2) }
    })()`)
    const realClick = async (x, y) => {
        for (const type of ['mousePressed', 'mouseReleased'])
            await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1,
                buttons: type === 'mousePressed' ? 1 : 0 })
    }
    await realClick(setup2.x, setup2.y)
    await sleep(250)
    await key('End', 'End')
    await key('Enter', 'Enter', String.fromCharCode(13))
    await key('z', 'KeyZ', 'z')
    await sleep(150)
    const mid = await evl(`(() => { const ta = document.querySelector('#write textarea')
        return { 框里: JSON.stringify(ta ? ta.value : null), 行: ta ? ta.rows : null } })()`)
    await realClick(setup2.tx, setup2.ty)
    await sleep(250)
    console.log('真键盘敲完：', mid.框里, mid.行, '→ 点别处提交后：',
        await evl(`(() => { const P = window.__mdkit
            return JSON.stringify(P.text()) + ' 往返=' + (P.serialize() === P.text()) })()`))

    /* Esc 退出编辑：这条没有 mousedown 抢先提交，全靠 focusout —— 上面那个双提交就在这条路上 */
    const setup3 = await evl(`(async () => {
        const NL = String.fromCharCode(10), B = String.fromCharCode(96), F = B + B + B
        const P = window.__mdkit
        P.load(['前', '', F + 'ts', 'let a = 1', F, '', '后'].join(NL) + NL, 'c.md', null)
        await new Promise(r => requestAnimationFrame(r))
        const r = document.querySelector('#write .md-code-block').getBoundingClientRect()
        return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) }
    })()`)
    await realClick(setup3.x, setup3.y)
    await sleep(250)
    await key('End', 'End')
    await key('Enter', 'Enter', String.fromCharCode(13))
    await key('q', 'KeyQ', 'q')
    await sleep(120)
    await key('Escape', 'Escape')
    await sleep(250)
    console.log('敲完按 Esc 之后：', await evl(`(() => { const P = window.__mdkit
        return JSON.stringify(P.text()) + ' 往返=' + (P.serialize() === P.text()) })()`))
    if (!skip) {
        for (const type of ['mousePressed', 'mouseReleased'])
            await send('Input.dispatchMouseEvent', { type, x: m.click.x, y: m.click.y, button: 'left', clickCount: 1,
                buttons: type === 'mousePressed' ? 1 : 0 })
        await sleep(400)
        console.log('两行引用点下去之后：', JSON.stringify(await evl(AFTER), null, 1))
    }
} catch (e) {
    console.log('探针失败：', e.message)
} finally {
    chrome.kill()
    await sleep(500)
    try { rmSync(work, { recursive: true, force: true }) } catch { /* 进程还没退干净 */ }
}
