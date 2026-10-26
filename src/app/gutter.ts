/**
 * 行号栏发哪些号：图二那个密度 —— 只给第 1 行和每 10 行发号，
 * 当前那一行由 main.ts 另发（CSS 算不出光标在哪）。
 * k 是"块内/框内第几个行高"，主题用 calc(k × 1lh) 摆位置。
 */
export function lineMarks(lines: number): { k: number, n: number }[] {
    const out: { k: number, n: number }[] = []
    for (let n = 1; n <= Math.max(1, lines); n++)
        if (n === 1 || n % 10 === 0) out.push({ k: n - 1, n })
    return out
}
