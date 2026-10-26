/*
 * 查找 / 替换。纯函数，DOM 一律不碰 —— 这样"命中区间对不对、替换几次、
 * 替换完还能不能逐字节存回去"都能在 Node 里量，不用开浏览器。
 *
 * 搜的是**源码文本**，不是渲染后的可见文字：`**粗**` 里搜"粗"要能中，
 * 但命中的区间会连着 `**` 一起落在同一个块里 —— 定位到块、高亮能映射的那段。
 */

export interface Hit {
    start: number
    end: number
}

/**
 * 大小写规则照 Typora：查询串里出现大写字母才区分大小写。
 * 这条是行为选择，写在测试里钉住。
 */
export function caseSensitive(q: string): boolean {
    return q !== q.toLowerCase()
}

export function findMatches(text: string, q: string): Hit[] {
    if (q === '') return []
    const out: Hit[] = []
    const cs = caseSensitive(q)
    const hay = cs ? text : text.toLowerCase()
    const needle = cs ? q : q.toLowerCase()
    let at = hay.indexOf(needle)
    while (at !== -1) {
        out.push({ start: at, end: at + needle.length })
        at = hay.indexOf(needle, at + needle.length)
    }
    return out
}

/** 替换第 index 个命中；越界或空命中就原样返回，不动文本 */
export function replaceOne(text: string, q: string, repl: string, index: number): { text: string, changed: boolean } {
    const hits = findMatches(text, q)
    const h = hits[index]
    if (!h) return { text, changed: false }
    return { text: text.slice(0, h.start) + repl + text.slice(h.end), changed: true }
}

/**
 * 全部替换：从后往前换，这样前面的命中区间不会因为后面的替换而位移。
 */
export function replaceAll(text: string, q: string, repl: string): { text: string, count: number } {
    const hits = findMatches(text, q)
    let out = text
    for (let i = hits.length - 1; i >= 0; i--)
        out = out.slice(0, hits[i].start) + repl + out.slice(hits[i].end)
    return { text: out, count: hits.length }
}

/** 落在 [from,to) 区间里的那些命中（渲染器按叶子节点切高亮用） */
export function hitsIn(hits: Hit[], from: number, to: number): Hit[] {
    return hits.filter(h => h.start >= from && h.end <= to)
}

/** 命中所在块的序号：往上找第一个包住它的块 */
export function blockOf(blocks: { start: number, end: number }[], h: Hit): number {
    for (let i = 0; i < blocks.length; i++)
        if (h.start >= blocks[i].start && h.end <= blocks[i].end) return i
    return -1
}
