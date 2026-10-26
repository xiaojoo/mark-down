import { describe, expect, it } from 'vitest'
import { exportHtml, THEME_CSS_BYTES } from '../src/render/export.ts'
import { renderBlocks } from '../src/render/html.ts'
import { openChunked, blocks } from '../src/kernel/parse.ts'

const bodyOf = (src: string) => {
    const c = openChunked(src)
    return renderBlocks(blocks(c), { text: c.text, editing: -1 })
}

describe('导出自包含 HTML', () => {
    it('样式整份内联，导出与屏上用的是同一个渲染器', () => {
        const src = '# 标题\n\n段落 **粗**\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
        const html = exportHtml('t', bodyOf(src))
        expect(html.startsWith('<!doctype html>')).toBe(true)
        expect(html).toContain('<style>\n')
        expect(html).toContain('@media print')          /* 打印规则跟着一起走 */
        expect(html).toContain('.md-meta')
        expect(html).toContain(bodyOf(src))             /* 正文逐字节就是渲染产物 */
        expect(html.length).toBeGreaterThan(THEME_CSS_BYTES + bodyOf(src).length)
    })

    it('标题转义，产物里不出现 script 标签', () => {
        const html = exportHtml('</title><script>x</script>', '<p>ok</p>')
        expect(html).toContain('&lt;/title&gt;')
        expect(html).not.toContain('<script')
    })

    it('正文里的 html 块与脚本不会在导出里复活', () => {
        const html = exportHtml('t', bodyOf('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n'))
        expect(html).not.toContain('onerror=alert(1)>')   /* 只剩转义后的文本 */
        expect(html).not.toContain('<script>alert(2)')
    })

    it('打印样式把颜色重新钉成黑白', () => {
        const c = openChunked('# t\n')
        const css = exportHtml('t', renderBlocks(blocks(c), { text: c.text, editing: -1 }))
        const print = css.slice(css.indexOf('@media print'))
        expect(print).toMatch(/--fg:\s*#111/)
        /* 标记这条不再归 @media print 管：预览本来就不显示格式码，打印只是它的子集 */
        expect(css).toMatch(/\.md-meta \{ display: none; \}/)
        /* #tip 也在里面：那是自绘的悬停气泡，跟着打印就会在纸上留一句提示 */
        expect(print).toContain('#bar, #side, #status, #drop, #findbox, #tip, #ask, #doctabs, #help, #pagebox { display: none !important; }')
    })

    /* 反证：渲染器换一个块序，导出正文必须跟着变 */
    it('导出正文跟着文档内容变，不是写死的壳', () => {
        expect(exportHtml('t', bodyOf('甲\n'))).not.toBe(exportHtml('t', bodyOf('乙\n')))
    })
    /* 页面设置那条 @page 必须跟着导出走：屏幕上打印看到的是纸，导出后再打印换了纸就是两套话 */
    it('导出带上页面设置那条 @page，且排在主题之后', () => {
        const css = '@page { size: 148mm 210mm; margin: 10mm 12mm 10mm 12mm; }'
        const out = exportHtml('t', '<p>x</p>', css)
        expect(out).toContain(css)
        expect(out.indexOf(css)).toBeGreaterThan(out.indexOf('.md-block'))
        expect(exportHtml('t', '<p>x</p>')).not.toContain(css)
    })
})
