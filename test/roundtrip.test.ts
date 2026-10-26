import { describe, expect, it } from 'vitest'
import { parse, serializeDoc } from '../src/kernel/parse.ts'
import { serialize } from '../src/kernel/node.ts'
import { ROUNDTRIP } from './corpus.ts'

/* 语料与覆盖面说明在 test/corpus.ts（三把尺子共用同一批文档） */
const corpus = ROUNDTRIP

describe('逐字节往返', () => {
    it.each(corpus)('%s', (_name, src) => {
        expect(serializeDoc(parse(src))).toBe(src)
    })
})

/*
 * 反证：门禁得有牙。改掉一个标记字节，同样的断言必须变红 ——
 * 否则上面那 60 条只是在测"函数返回了个字符串"。
 */
describe('门禁能分辨', () => {
    const src = '# 综合文档\n\n> q\n\n```js\nx\n```\n'

    it('改掉一个 close 字节就不相等', () => {
        const doc = parse(src)
        expect(serialize(doc.root)).toBe(src)
        expect(doc.root.close).toBe('\n')
        doc.root.close += 'X'
        expect(serialize(doc.root)).not.toBe(src)
    })

    it('改掉 setext 的 underline 标记就不相等', () => {
        const doc = parse('title\n===\n')
        const heading = doc.root.children[0]
        expect(heading.type).toBe('heading')
        expect(heading.close).toBe('\n===')
        heading.close = '\n---'
        expect(serializeDoc(doc)).toBe('title\n---\n')
    })
})
