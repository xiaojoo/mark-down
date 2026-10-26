export interface Node {
    type: string
    /* 第一个子节点之前（或叶子的内容之前）那一段源文本：标记、缩进 */
    open: string
    /* 相邻子节点之间，长度 = children.length - 1 */
    sep: string[]
    /* 最后一个子节点之后 */
    close: string
    /* 叶子的全部源文本；容器为空串 */
    body: string
    children: Node[]
}

export function serialize(n: Node): string {
    if (n.children.length === 0) return n.open + n.body + n.close
    let s = n.open
    for (let i = 0; i < n.children.length; i++) {
        if (i > 0) s += n.sep[i - 1]
        s += serialize(n.children[i])
    }
    return s + n.close
}

/* 树里任何一个子树在源码里的区间 */
export interface Span {
    node: Node
    start: number
    end: number
    kids: Span[]
}

/**
 * 由树自己算偏移：孩子起点 = 父起点 + open + 前面所有兄弟与其间空隙的长度。
 *
 * 之所以能这么算，是因为平铺时把区间夹成了"严格铺满"—— serialize(node) 恒等于
 * 它那段源码，反过来长度就能还原区间。判据在 test/span.test.ts：
 * 对每个节点 text.slice(start, end) === serialize(node)。
 */
export function span(n: Node, start: number): Span {
    const kids: Span[] = []
    let cursor = start + n.open.length
    if (n.children.length === 0) cursor += n.body.length
    else {
        n.children.forEach((c, i) => {
            if (i > 0) cursor += n.sep[i - 1].length
            const s = span(c, cursor)
            kids.push(s)
            cursor = s.end
        })
    }
    return { node: n, start, end: cursor + n.close.length, kids }
}
