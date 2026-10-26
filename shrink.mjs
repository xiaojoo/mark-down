import { openChunked, blocks } from './src/kernel/parse.ts'
import { findMatches } from './src/app/find.ts'
import { readFileSync } from 'node:fs'
const main = readFileSync('src/app/main.ts', 'utf8')
const demo = /const DEMO = `([\s\S]*?)\n`/.exec(main)[1].replace(/\\*`/g, '`')
const c = openChunked(demo)
const bs = blocks(c)
for (const h of findMatches(c.text, '源码')) {
  const b = bs.findIndex(b => h.start >= b.start && h.end <= b.end)
  console.log(`命中 [${h.start},${h.end}) 在块 ${b} (${bs[b]?.node.type}) 上下文=${JSON.stringify(c.text.slice(h.start - 14, h.end + 6))}`)
}
