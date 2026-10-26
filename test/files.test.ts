import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { copyDoc, decodeAs, moveTo, readText, renameDoc, writeBytes, writeText, type DirHandle, type FileHandle } from '../src/app/files.ts'
import { nextCopyName } from '../src/app/actions.ts'

/*
 * 真写盘的测法：这三条在浏览器里必须等一次真用户手势 + 一个原生弹框，
 * 而这台 Chrome 155 的 CDP 能拦截弹框却没有回答它的方法（Page 域里只有
 * setInterceptFileChooserDialog，没有 handleFilePicker）—— 所以走另一条：
 * **被测代码就是应用里那一份**（src/app/files.ts），只是把句柄换成一个
 * 用 node:fs 实现的替身。文件是真的落到临时目录、真的再读回来对字节。
 *
 * 测不到的那一层也写明白：Chrome 真实的权限授予、弹框语义、以及 move() 在
 * Chromium 里的实际行为，这里一概没证 —— 那部分仍然要人点一次。
 */

function domError(name: string): Error { const e = new Error(name); (e as Error & { name: string }).name = name; return e }

function fileHandle(p: string, movable = true): FileHandle {
    const h: FileHandle = {
        name: basename(p),
        async getFile() {
            const buf = readFileSync(p)
            return {
                name: basename(p),
                async text() { return buf.toString('utf8') },
                async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer },
            }
        },
        async createWritable() {
            const chunks: Buffer[] = []
            return {
                async write(c: string | ArrayBuffer) { chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c)) },
                async close() { writeFileSync(p, Buffer.concat(chunks)) },
            }
        },
    }
    /* 和 Chrome 一个样：move() 不返回句柄，改名作用在**这个**句柄上（真测出来的语义） */
    if (movable) (h as { move?: unknown }).move = async (a: unknown, b?: string) => {
        const to = typeof a === 'string' ? join(p, '..', a) : join((a as DirHandle & { at: string }).at, b as string)
        renameSync(p, to)
        ;(h as { name: string }).name = basename(to)
        return undefined
    }
    return h
}

function dirHandle(at: string): DirHandle & { at: string } {
    return {
        name: basename(at), at,
        async getFileHandle(n: string, o?: { create?: boolean }) {
            const f = join(at, n)
            if (!existsSync(f) && !o?.create) throw domError('NotFoundError')
            return fileHandle(f)
        },
        async removeEntry(n: string) { rmSync(join(at, n), { force: true }) },
    }
}

function fixture(): { dir: DirHandle & { at: string }, sub: DirHandle & { at: string }, at: string, root: string } {
    const root = mkdtempSync(join(tmpdir(), 'mdkit-fs-'))
    const a = join(root, 'docs'); const b = join(root, 'elsewhere')
    for (const d of [a, b]) mkdirSync(d, { recursive: true })
    writeFileSync(join(a, 'a.md'), '# 甲\n')
    /* at = 文档所在那个目录；root = 一次性的整棵，收尾删它 */
    return { dir: dirHandle(a), sub: dirHandle(b), at: a, root }
}

describe('真写盘：句柄那一层跑在真文件系统上', () => {
    it('创建副本：新文件真的出现，字节和原来同一份', async () => {
        const { dir, at: path, root } = fixture()
        const text = '# 甲' + String.fromCharCode(10)
        const r = await copyDoc(dir, 'a.md', text, ['a.md'], 'lf', nextCopyName)
        expect(r).toEqual({ ok: true, at: 'a 副本.md' })
        expect(readFileSync(join(path, 'a 副本.md'), 'utf8')).toBe(text)
        rmSync(root, { recursive: true, force: true })
    })
    it('副本占着就往后让号；换行符按选定的档落地', async () => {
        const { dir, at: path, root } = fixture()
        writeFileSync(join(path, 'a 副本.md'), 'x')
        const r = await copyDoc(dir, 'a.md', 'a' + String.fromCharCode(10) + 'b', ['a.md', 'a 副本.md'], 'crlf', nextCopyName)
        expect(r.ok && r.at).toBe('a 副本 2.md')
        /* CRLF 是真的落在字节上的：写进去的那份文件本身带 
 */
        expect(readFileSync(join(path, 'a 副本 2.md')).toString('utf8'))
            .toBe('a' + String.fromCharCode(13, 10) + 'b')
        rmSync(root, { recursive: true, force: true })
    })
    it('写不进去要回报，不许悄悄返回成功', async () => {
        const broken: DirHandle = { name: 'no', async getFileHandle() { throw domError('NotAllowedError') } }
        const r = await copyDoc(broken, 'a.md', 'x', [], 'lf', nextCopyName)
        expect(r.ok).toBe(false)
        expect((r as { why: string }).why).toContain('NotAllowedError')
    })
    it('图片那种字节流也走同一颗（writeBytes 写进去读回来）', async () => {
        const { dir, at: path, root } = fixture()
        const h = await dir.getFileHandle('pic.png', { create: true })
        const bytes = new Uint8Array([137, 80, 78, 71])
        await writeBytes(h, bytes.buffer.slice(0) as ArrayBuffer)
        expect(Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer()))).toEqual([137, 80, 78, 71])
        rmSync(root, { recursive: true, force: true })
    })
    it('重新命名：旧名没了、新名在、内容没动', async () => {
        const { dir, at: path, root } = fixture()
        const h = await dir.getFileHandle('a.md')
        const r = await renameDoc(h, 'b.md')
        expect(r).toEqual({ ok: true, at: 'b.md' })
        expect(existsSync(join(path, 'a.md'))).toBe(false)
        expect(readFileSync(join(path, 'b.md'), 'utf8')).toBe('# 甲' + String.fromCharCode(10))
        rmSync(root, { recursive: true, force: true })
    })
    it('没有 move 的浏览器直说不支持；名字没变也不许当成功', async () => {
        const { dir, at: path, root } = fixture()
        const nomove = fileHandle(join(path, 'a.md'), false)
        expect(await renameDoc(nomove, 'b.md')).toEqual({ ok: false, why: '这个浏览器不支持原地改名（Chromium 才有 move）' })
        expect(existsSync(join(path, 'b.md'))).toBe(false)
        const h = await dir.getFileHandle('a.md')
        expect((await renameDoc(h, 'a.md')).ok).toBe(false)
        expect((await renameDoc(null, 'b.md')).ok).toBe(false)
        rmSync(root, { recursive: true, force: true })
    })
    it('移动到别的目录：那边有、这边没', async () => {
        const { dir, sub, at: path, root } = fixture()
        const h = await dir.getFileHandle('a.md')
        const r = await moveTo(h, sub)
        expect(r.ok).toBe(true)
        expect(existsSync(join(path, 'a.md'))).toBe(false)
        expect(readFileSync(join(sub.at, 'a.md'), 'utf8')).toBe('# 甲' + String.fromCharCode(10))
        rmSync(root, { recursive: true, force: true })
    })
    it('按编码重读：GBK 的字节解成汉字，BOM 剥掉，解不了的报话', async () => {
        const { dir, at: path, root } = fixture()
        writeFileSync(join(path, 'gbk.md'), Buffer.from([0xCE, 0xD2, 0xB5, 0xC4]))      /* 我的 */
        const gbk = await decodeAs(await dir.getFileHandle('gbk.md'), 'gbk')
        expect(gbk.ok && gbk.text).toBe('我的')
        writeFileSync(join(path, 'bom.md'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('甲', 'utf8')]))
        const bom = await decodeAs(await dir.getFileHandle('bom.md'), 'utf-8')
        expect(bom.ok && bom.text).toBe('甲')
        expect((await decodeAs(await dir.getFileHandle('a.md'), '不是个编码')).ok).toBe(false)
        rmSync(root, { recursive: true, force: true })
    })
    it('readText 与 writeText 是同一份字节（写进去读回来一字不差）', async () => {
        const { dir, at: path, root } = fixture()
        const h = await dir.getFileHandle('a.md')
        const src = '# 甲' + String.fromCharCode(10) + '带公式 $x^2$' + String.fromCharCode(10)
        await writeText(h, src, 'lf')
        expect(await readText(h)).toBe(src)
        expect(readFileSync(join(path, 'a.md'), 'utf8')).toBe(src)
        rmSync(root, { recursive: true, force: true })
    })
    /* 应用里不许有第二条写盘路：要落地只能经 files.ts 那几个函数 */
    it('main.ts 里不再自己碰 createWritable / TextDecoder', () => {
        const main = readFileSync('src/app/main.ts', 'utf8')
        expect(main).not.toMatch(/createWritable/)
        expect(main).not.toMatch(/new TextDecoder/)
    })
})
