import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * 把 theme.css 抄成一份 TS 常量给导出用。
 *
 * 为什么不直接 import css：Vite 的 .css 导入是"注入样式"，默认导出不是文本；
 * esbuild 的 --loader:.css=text 又是另一套行为。两边共用一个生成物最省事，
 * 代价是要防漂移 —— test/theme-sync.test.ts 会逐字节比对这两份。
 */
const SRC = 'src/styles/theme.css'
const OUT = 'src/styles/themeCss.ts'

const css = readFileSync(SRC, 'utf8')
const body = '/* 由 tools/gen-css.mjs 从 src/styles/theme.css 生成，不要手改 */\n'
    + `export const THEME_CSS = ${JSON.stringify(css)}\n`
writeFileSync(OUT, body)
console.log(`theme.css ${css.length} 字符 -> themeCss.ts ${body.length} 字符`)

/*
 * KaTeX：数学公式的渲染层。三个产物，各有各的去处 ——
 *   app/katex/katex.min.css + app/katex/fonts/   应用自己用的那份（浏览器从本地文件读字体，不占包体）
 *   src/styles/katexCss.ts                       同一份 CSS 抄成常量，导出时内联进去
 *   app/katex/fonts.js                           全部字体的 base64 表，只在导出带公式的文档时才注入
 *
 * 为什么字体表不跟着 mdkit.js 一起打进去：那是 1.4 MB，而绝大多数文档一个公式都没有 ——
 * 让每次开机都背它，等于让所有人替写公式的人付账。导出时才按这份文档真正用到的字集取。
 */
const KX = 'node_modules/katex/dist'
const kxCss = readFileSync(join(KX, 'katex.min.css'), 'utf8')
mkdirSync('app/katex/fonts', { recursive: true })
copyFileSync(join(KX, 'katex.min.css'), 'app/katex/katex.min.css')
for (const f of readdirSync(join(KX, 'fonts'))) copyFileSync(join(KX, 'fonts', f), join('app/katex/fonts', f))
const faces = [...new Set([...kxCss.matchAll(/url\((fonts\/[^)?#]+)\)/g)].map(m => m[1]))]
const map = {}
for (const rel of faces) map[rel] = readFileSync(join(KX, rel)).toString('base64')
const genHeader = '/* 由 tools/gen-css.mjs 生成，不要手改 */'
writeFileSync('app/katex/fonts.js', genHeader + '\n'
    + 'window.__katexFonts = ' + JSON.stringify(map) + '\n')
const kxBody = '/* 由 tools/gen-css.mjs 从 node_modules/katex/dist/katex.min.css 生成，不要手改 */'
    + '\n' + 'export const KATEX_CSS = ' + JSON.stringify(kxCss) + '\n'
writeFileSync('src/styles/katexCss.ts', kxBody)
const kb = Math.round(Object.values(map).reduce((a, b) => a + b.length, 0) / 1024)
console.log('katex.min.css ' + kxCss.length + ' 字符，字体 ' + faces.length + ' 个 (' + kb + ' KB base64) -> app/katex/')
