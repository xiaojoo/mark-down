import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * 一次性探针：headless Chrome 能不能替 File System Access 的弹框给出答案。
 * 能，则"创建副本 / 重新命名 / 移动到 / 导入 / 导出到磁盘"这几条可以端到端真测；
 * 不能，就只能报"测到哪一层"，不许假装验过。
 */
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const work = mkdtempSync(join(tmpdir(), 'mdkit-cdp-'))
const fixture = join(work, 'fix')
mkdirSync(fixture, { recursive: true })
writeFileSync(join(fixture, 'a.md'), '# 甲\n')

const html = join(work, 'probe.html')
writeFileSync(html, `<!doctype html><meta charset="utf-8"><body style="margin:0">
<button id="f" style="position:absolute;left:40px;top:40px;width:160px;height:40px">file</button>
<button id="d" style="position:absolute;left:40px;top:100px;width:160px;height:40px">dir</button>
<pre id="out"></pre>
<script>
window.__log = []
const say = (s) => { window.__log.push(s); document.getElementById('out').textContent = window.__log.join('\\n') }
window.__say = say
document.getElementById('f').onclick = async () => {
    try { const h = await showOpenFilePicker(); say('file ok ' + h[0].name) }
    catch (e) { say('file throw ' + e.name + ' ' + e.message) }
}
document.getElementById('d').onclick = async () => {
    try { const h = await showDirectoryPicker(); say('dir ok ' + h.name) }
    catch (e) { say('dir throw ' + e.name + ' ' + e.message) }
}
say('has picker ' + (typeof showOpenFilePicker) + ' / ' + (typeof showDirectoryPicker))
</script></body>`)

const chrome = spawn(CHROME, [
    `--headless=new`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`,
    `--no-first-run`, `--no-default-browser-check`, `--disable-gpu`, `--window-size=1280,900`,
    `--allow-file-access-from-files`, `file:///${html.replace(/\\/g, '/')}`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function targets() {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return (await res.json()).filter(t => t.type === 'page')
}

let id = 0
const pending = new Map()
let ws
function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const n = ++id
        pending.set(n, { resolve, reject })
        ws.send(JSON.stringify({ id: n, method, params }))
    })
}
const events = []
async function connect() {
    for (let i = 0; i < 40; i++) {
        try {
            const t = await targets()
            if (t.length) {
                ws = new WebSocket(t[0].webSocketDebuggerUrl)
                await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
                ws.onmessage = m => {
                    const msg = JSON.parse(m.data)
                    if (msg.id && pending.has(msg.id)) {
                        const p = pending.get(msg.id); pending.delete(msg.id)
                        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
                    } else if (msg.method) events.push(msg)
                }
                return
            }
        } catch { /* 还没起来 */ }
        await sleep(500)
    }
    throw new Error('CDP 连不上')
}

async function click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
}
const evOf = m => events.filter(e => e.method === m)

try {
    await connect()
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.setInterceptFileChooserDialog', { enabled: true })
    const ev = await send('Runtime.evaluate', { expression: 'window.__log.join(" | ")', returnByValue: true })
    console.log('页面自报：', ev.result.value)

    await click(120, 120)
    await sleep(1500)
    console.log('file 按钮 → fileChooserOpened:', JSON.stringify(evOf('Page.fileChooserOpened').map(e => e.params)))
    const fo = evOf('Page.fileChooserOpened').pop()
    if (fo) {
        try {
            await send('Page.handleFilePicker', { files: [join(fixture, 'a.md').replace(/\\/g, '/')] })
        } catch (e) { console.log('handleFilePicker(file) 抛：', e.message) }
        await sleep(800)
        console.log('  结果：', (await send('Runtime.evaluate', { expression: 'window.__log.join(" | ")', returnByValue: true })).result.value)
    }

    await click(120, 180)
    await sleep(1500)
    console.log('dir 按钮 → fileChooserOpened 次数:', evOf('Page.fileChooserOpened').length)
    const fo2 = evOf('Page.fileChooserOpened').slice(-1)[0]
    if (fo2 && evOf('Page.fileChooserOpened').length > 1) {
        try {
            await send('Page.handleFilePicker', { files: [fixture.replace(/\\/g, '/')] })
        } catch (e) { console.log('handleFilePicker(dir) 抛：', e.message) }
        await sleep(800)
        console.log('  结果：', (await send('Runtime.evaluate', { expression: 'window.__log.join(" | ")', returnByValue: true })).result.value)
    }
} catch (e) {
    console.log('探针失败：', e.message)
} finally {
    chrome.kill()
    await sleep(400)
    try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 上进程还没退干净，删不掉就算了 */ }
}
