import { toEol } from './actions.ts'

/*
 * 句柄操作单独一层。
 *
 * 为什么单独一层：这三条（创建副本 / 重新命名 / 移动到）在浏览器里必须等一次真用户手势 +
 * 一个原生弹框，自动化点不出来（这台 Chrome 155 的 CDP 能拦截弹框、却没有回答它的方法）。
 * 逻辑留在 main.ts 里就永远测不到 —— 所以搬到这里，参数是句柄，返回值是"成没成 + 为什么"，
 * main.ts 只负责拿句柄和把话说到状态栏。
 *
 * 类型故意写成我们**用到的那几个方法**，不是 DOM 的那一大坨：假句柄（test/files.test.ts 里
 * 用 node:fs 实现）和真句柄都能塞进来，浏览器里的 FileSystemFileHandle 天然满足。
 */

export interface FileLike {
    readonly name: string
    text(): Promise<string>
    arrayBuffer(): Promise<ArrayBuffer>
}

export interface WritableLike {
    /* 字符串（markdown / HTML）、ArrayBuffer 与 Blob（粘进来的图片）都从这一颗走 */
    write(chunk: string | ArrayBuffer | Blob): Promise<void>
    close(): Promise<void>
}

export interface FileHandle {
    name: string
    getFile(): Promise<FileLike>
    createWritable(): Promise<WritableLike>
    /**
     * Chromium 私有：move(新名) 原地改名，move(目录, 新名) 跨目录移动。
     * 量过的语义（Chrome 155，真句柄）：**resolve 的是 undefined**，改名作用在原句柄上
     * （h.name 跟着变，h.getFile() 还能读到那份文件）。所以别去用返回值。
     */
    move?: ((name: string) => Promise<unknown>) & ((dir: DirHandle, name: string) => Promise<unknown>)
}

export interface DirHandle {
    name: string
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>
    removeEntry?(name: string): Promise<void>
}

export type Outcome = { ok: true, at: string } | { ok: false, why: string }

/** 唯一的写盘出口：文本走 writeText（换行符在这里转），字节走 writeBytes（图片、导出件） */
export async function writeText(h: FileHandle, text: string, eol: 'lf' | 'crlf' | 'cr'): Promise<void> {
    const w = await h.createWritable()
    await w.write(toEol(text, eol))
    await w.close()
}

export async function writeBytes(h: FileHandle, data: ArrayBuffer | Blob): Promise<void> {
    const w = await h.createWritable()
    await w.write(data)
    await w.close()
}

export async function readText(h: FileHandle): Promise<string> {
    return (await h.getFile()).text()
}

/** 按指定编码重读一个文件；解不了的不抛，交回话头让界面去说 */
export async function decodeAs(h: FileHandle, enc: string): Promise<{ ok: true, text: string } | { ok: false, why: string }> {
    let buf: ArrayBuffer
    try { buf = await (await h.getFile()).arrayBuffer() } catch { return { ok: false, why: '读不到文件内容' } }
    let text: string
    try { text = new TextDecoder(enc).decode(buf) } catch { return { ok: false, why: `这台浏览器解不了 ${enc}` } }
    return { ok: true, text: text.replace(/^\uFEFF/, '') }
}

/**
 * 创建副本：写一份新文件，名字让号。返回落在哪。
 * 不打开它 —— 副本是备份，抢走当前编辑目标是不讲理的。
 */
export async function copyDoc(dir: DirHandle, name: string, text: string,
    taken: string[], eol: 'lf' | 'crlf' | 'cr', nextName: (n: string, t: string[]) => string):
    Promise<Outcome> {
    const out = nextName(name, taken)
    try {
        const h = await dir.getFileHandle(out, { create: true })
        await writeText(h, text, eol)
        return { ok: true, at: out }
    } catch (e) { return { ok: false, why: `写不进 ${dir.name}/：${(e as Error).name}` } }
}

/** 改名。没有 move() 的浏览器直说没有，不假装成功 */
export async function renameDoc(h: FileHandle | null, to: string): Promise<Outcome> {
    if (!h) return { ok: false, why: '这一篇还没落到文件上，无从改名' }
    if (typeof h.move !== 'function') return { ok: false, why: '这个浏览器不支持原地改名（Chromium 才有 move）' }
    if (!to.trim() || to === h.name) return { ok: false, why: '新名字没变' }
    try {
        await h.move(to)
        return { ok: true, at: h.name }          /* 返回值是 undefined：名字问句柄自己拿 */
    } catch (e) { return { ok: false, why: `重命名失败：${(e as Error).name}` } }
}

export async function moveTo(h: FileHandle | null, dir: DirHandle | null): Promise<Outcome> {
    if (!h) return { ok: false, why: '这一篇还没落到文件上，无从移动' }
    if (!dir) return { ok: false, why: '没选目标目录' }
    if (typeof h.move !== 'function') return { ok: false, why: '这个浏览器不支持移动文件（Chromium 才有 move）' }
    const name = h.name
    try {
        await h.move(dir, name)
        return { ok: true, at: `${dir.name}/${name}` }
    } catch (e) { return { ok: false, why: `移动失败：${(e as Error).name}` } }
}
