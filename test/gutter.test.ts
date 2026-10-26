import { describe, expect, it } from 'vitest'
import { lineMarks } from '../src/app/gutter.ts'

/*
 * 行号栏的号该发在哪几行：图二那个密度 —— 第 1 行 + 每 10 行。
 * k 是"框内第几个行高"，主题用 calc(k × 1lh) 摆位置，所以 k 必须从 0 起。
 */
describe('行号栏的发号规则', () => {
    it('12 行的文档发 1 和 10，k 从 0 起', () => {
        expect(lineMarks(12)).toEqual([{ k: 0, n: 1 }, { k: 9, n: 10 }])
    })
    it('25 行发到 1 / 10 / 20，不多发末尾', () => {
        expect(lineMarks(25).map(m => m.n)).toEqual([1, 10, 20])
    })
    it('空文档也有一行，发一个 1', () => {
        expect(lineMarks(0)).toEqual([{ k: 0, n: 1 }])
    })
    /* 反证：密度判据不是恒真 —— 少发一号或多发一号都该被抓住 */
    it('反证：每 5 行发一号会立刻被这条抓住', () => {
        const everyFive = [1, 5, 10, 15].map(n => ({ k: n - 1, n }))
        expect(everyFive.map(m => m.n)).not.toEqual(lineMarks(16).map(m => m.n))
    })
})
