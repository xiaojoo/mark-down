import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'

const cases = [
  ['blockquote 多行', '> a\n> b\n'],
  ['列表嵌套', '- one\n  - two\n- three\n'],
  ['有序列表宽标记', '10. ten\n    cont\n'],
  ['setext', 'title\n===\n'],
  ['atx 带闭合井', '## hi ##\n'],
  ['围栏代码', '```ts\nlet a = 1\n```\n'],
  ['缩进代码', '    code\n'],
  ['换行段内', 'foo\nbar\nbaz\n'],
  ['frontmatter', '---\ntitle: x\n---\nbody\n'],
  ['gfm 表格', '| a | b |\n| - | - |\n| 1 | 2 |\n'],
  ['gfm 脚注', 'x[^1]\n\n[^1]: note\n'],
  ['任务列表', '- [ ] todo\n- [x] done\n'],
  ['强调内含标记', 'a *b\n c* d\n'],
  ['链接', '[t](u "ti")\n'],
  ['裸 html 块', '<div>\n  <p>x</p>\n</div>\n'],
  [' thematic break', '***\n'],
]

function walk(node, src, depth) {
  const s = node.position.start.offset
  const e = node.position.end.offset
  const slice = src.slice(s, e)
  console.log('  '.repeat(depth) + `${node.type} [${s},${e}) ${JSON.stringify(slice)}`)
  for (const c of node.children ?? []) walk(c, src, depth + 1)
}

for (const [name, src] of cases) {
  console.log(`\n=== ${name} === src=${JSON.stringify(src)}`)
  const tree = fromMarkdown(src, {
    extensions: [gfm(), frontmatter(['yaml', 'toml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])],
  })
  walk(tree, src, 0)
}
