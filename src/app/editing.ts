/*
 * 编辑态里"回车该干什么"的判断。纯函数，DOM 不碰 —— 这样"两次回车新增模块"
 * 这条行为能在 Node 里逐条量出来，不用靠手点。
 *
 * 规则（Typora 那一套）：
 *   光标在文末、且当前内容已经以换行结尾（说明上一行是空行）→ 回车 = 结束这一块、另起一块
 *   其余情况 → 回车 = 普通换行
 */
export type EnterResult = 'newline' | 'split'

export function enterAction(value: string, caret: number): EnterResult {
    if (caret !== value.length) return 'newline'
    return value.endsWith('\n') ? 'split' : 'newline'
}

/**
 * 在 at 处插入一个新块，返回要 splice 的 [from,to) 与串。
 *
 * 麻烦在于"at 前面到底留了几个换行"有三种情况：at 正好在块末尾（前面一个换行都不够，
 * 得补两个）、at 在块后的那个换行上（补一个）、at 已经在空行之后（不补）。
 * 判错就会把新块并进上一段 —— 这是源码模型里最容易悄悄错一位的地方。
 */
export function insertBlockAt(doc: string, at: number, block: string): { from: number, to: number, ins: string } {
    const before = doc.slice(0, at)
    const after = doc.slice(at).replace(/^\n+/, '')
    const b = block.replace(/\n+$/, '')
    const lead = before === '' || /\n\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n'
    return { from: at, to: doc.length - after.length, ins: lead + b + (after === '' ? '\n' : '\n\n') }
}
