import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 一次性：这台 Chrome 的 CDP 到底有没有"回答被拦截弹框"的方法。没有就别装能测。 */
const work = join(tmpdir(), 'mdkit-proto')
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${join(work, 'p')}`, '--no-first-run', 'about:blank'],
    { stdio: 'ignore' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
try {
    let doc = null
    for (let i = 0; i < 30 && !doc; i++) {
        try {
            const r = await fetch('http://127.0.0.1:9334/json/protocol')
            if (r.ok) doc = await r.json()
        } catch { /* 还没起来 */ }
        await sleep(500)
    }
    if (!doc) { console.log('拿不到 protocol'); }
    else {
        const domains = Array.isArray(doc) ? doc.flatMap(d => d.domains ?? []) : (doc.domains ?? [])
        const page = domains.find(d => d.domain === 'Page')
        const names = (page?.commands ?? []).map(c => c.name)
        console.log('Page 里带 File 的命令：', names.filter(n => /file/i.test(n)).join(', ') || '（无）')
        console.log('Page 命令总数：', names.length)
    }
} finally {
    chrome.kill()
    await sleep(500)
}
