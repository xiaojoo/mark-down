import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * 提示块（> [!NOTE]）：量三件事
 *  ① 预览里 `[!NOTE]` 这串标记到底显不显示（按设计应当藏起来，只留"说明"那颗角标）
 *  ② 点第一行 vs 点第二行，各自进的是哪种编辑态、"说明"还在不在
 *  ③ 提交一圈之后角标会不会永久丢掉
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = Number(process.env.PROBE_PORT ?? 9351)
const work = mkdtempSync(join(tmpdir(), 'mdkit-alert-'))
const APP = 'file:///' + join(process.cwd(), 'app/index.html').replace(/\\/g, '/')
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(work, 'p')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1280,900', APP], { stdio: 'ignore' })
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
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
const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1,
            buttons: type === 'mousePressed' ? 1 : 0 })
    await sleep(250)
}
const STATE = `(null)`
try {
    await connect()
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(700)
    const geo = await evl(`(async () => {
        const NL = String.fromCharCode(10)
        const P = window.__mdkit
        P.load(['> [!NOTE]', '> 提示块：这个标记留在源码里，只显示成带色的框', '', '别的一块'].join(NL) + NL, 'a.md', null)
        await new Promise(r => requestAnimationFrame(r))
        const b = document.querySelector('#write .md-alert')
        if (!b) return { 没有: '找不到 .md-alert' }
        window.__b = b
        const cs = getComputedStyle(b, '::before')
        const lines = [...b.querySelectorAll('.md-text')].map(t => ({
            文本: t.textContent.slice(0, 14), top: Math.round(t.getBoundingClientRect().top),
            区间: [t.dataset.s, t.dataset.e] }))
        return { 块类: b.className, 角标: cs.content, 角标高: cs.height || null,
            可见文本: b.textContent, 行: lines, 块顶: Math.round(b.getBoundingClientRect().top),
            左: Math.round(b.getBoundingClientRect().left),
            块高: +b.getBoundingClientRect().height.toFixed(2) }
    })()`)
    console.log('预览态：', JSON.stringify(geo, null, 1))
    if (!geo.行) { console.log('拿不到行坐标，停'); }
    else {
        const x = geo.左 + 24
        const first = geo.行[0], second = geo.行[1] ?? geo.行[0]
        await click(x, first.top + 4)
        console.log('点第一行之后：', JSON.stringify(await evl(`(() => {
            const b = document.querySelector('#write .md-block')
            const ta = document.querySelector('#write textarea')
            return { 块类: b.className, 有框: !!ta, 框区间: ta ? [ta.dataset.s, ta.dataset.e] : null,
                框里: ta ? JSON.stringify(ta.value.slice(0, 24)) : null,
                角标: getComputedStyle(b, '::before').content,
                alert类在块上: /md-alert/.test(b.className) } })()`)))
        await evl(`(() => { const ta = document.querySelector('#write textarea'); if (ta) ta.blur(); return 1 })()`)
        await sleep(200)
        await click(x, second.top + 4)
        console.log('点第二行之后：', JSON.stringify(await evl(`(() => {
            const b = document.querySelector('#write .md-block')
            const ta = document.querySelector('#write textarea')
            return { 块类: b.className, 有框: !!ta, 框区间: ta ? [ta.dataset.s, ta.dataset.e] : null,
                框里: ta ? JSON.stringify(ta.value.slice(0, 24)) : null,
                角标: getComputedStyle(b, '::before').content } })()`)))
        await evl(`(() => { const ta = document.querySelector('#write textarea'); if (ta) ta.blur(); return 1 })()`)
        await sleep(200)
        /* 用户报的那一态：点在"没有行内单元"的空白上 → 走整块编辑，
         * 那时内层 .md-blockquote 根本不存在，角标只能挂在外层 .md-block 上 */
        await click(geo.左 + 600, first.top + 4)
        console.log('点行尾空白（整块编辑）：', JSON.stringify(await evl(`(() => {
            const b = document.querySelector('#write .md-block')
            const ta = document.querySelector('#write textarea')
            return { 块类: b.className, 有框: !!ta, 框是整块: ta ? [ta.dataset.s, ta.dataset.e] : null,
                内层alert: !!b.querySelector('.md-alert'),
                角标: getComputedStyle(b, '::before').content } })()`)))
        await evl(`(() => { const ta = document.querySelector('#write textarea'); if (ta) ta.blur(); return 1 })()`)
        await sleep(200)
        console.log('提交一圈回到预览：', JSON.stringify(await evl(`(() => {
            const b = document.querySelector('#write .md-alert')
            const P = window.__mdkit
            return { 还在: !!b, 角标: b ? getComputedStyle(b, '::before').content : null,
                源码: JSON.stringify(P.text()), 往返: P.serialize() === P.text() } })()`)))
    }
} catch (e) {
    console.log('探针失败：', e.message)
} finally {
    chrome.kill()
    await sleep(500)
    try { rmSync(work, { recursive: true, force: true }) } catch { /* 进程没退干净 */ }
}
