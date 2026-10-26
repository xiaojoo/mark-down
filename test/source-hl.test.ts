import { describe, expect, it } from 'vitest'
import { highlightSource } from '../src/render/source.ts'
import { ROUNDTRIP } from './corpus.ts'

/*
 * 高亮层唯一要紧的底线：**它显示的字必须就是源码的字**。
 * 正则再怎么错，只能错在颜色上；只要有一个字符被吃掉或多出来，
 * 上面那层文本域和后面这层就会错行 —— 图一那种排版立刻散掉。
 */
const plain = (html: string) => html.split('<div class="hl-line ')
    .slice(1)
    .map(part => part.replace(/^[^>]*>/, '').replace(/<[^>]+>/g, ''))
    .join('\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

describe('源码高亮层不改字', () => {
    const DOC = '# 标题 `代码` **粗** [链接](u) <https://a.b>\n\n> 引用 `x`\n> 第二行\n'
        + '\n---\n\n```ts\nconst 号 = `反引号` // 注释 <b>\n```\n\n- [ ] 任务 **粗**\n'
        + '| 类型 | 去向 |\n| --- | --- |\n| `a` | b |\n\n[ty]: https://x "标题"\n\n未闭合的反引号 ` 和 星号 * 单独出现\n'

    it('剥掉所有标签后逐字符等于原文', () => {
        expect(plain(highlightSource(DOC))).toBe(DOC)
    })
    it('语料里每一篇都逐字符等于原文', () => {
        for (const [, src] of ROUNDTRIP) expect(plain(highlightSource(src)), src).toBe(src)
    })
    it('一行源码 = 一个 hl-line（行号和它必须一一对应）', () => {
        expect(highlightSource(DOC).match(/class="hl-line /g)?.length).toBe(DOC.split('\n').length)
        expect(highlightSource('').match(/class="hl-line /g)?.length).toBe(1)
    })
    /* 反证：围栏里的 # 不许被当成标题着色 */
    it('围栏内的行走代码样式，围栏外才认标题', () => {
        const out = highlightSource('```\n# 不是标题\n```\n\n# 是标题\n')
        expect(out).toContain('hl-code-line"># 不是标题')
        expect(out).toContain('hl-h"># 是标题')
    })
    /* 反证：判据本身能失败 —— 少吐一个字符就该被抓住 */
    it('反证：吃掉一个字符会被这条抓到', () => {
        const broken = highlightSource('a\n').replace('>a<', '>&lt;<')
        expect(plain(broken)).not.toBe('a\n')
    })
})
