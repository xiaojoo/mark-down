/*
 * 走压缩那份入口：包的 ESM 入口 dist/katex.mjs 是未压缩的 610 KB，
 * 打进 mdkit.js 要多吃 270 KB —— 而它对外只有一个 renderToString。
 */
declare module 'katex/dist/katex.min.js' {
    interface KatexOptions {
        displayMode?: boolean
        throwOnError?: boolean
        output?: 'html' | 'mathml' | 'htmlAndMathml'
    }
    const katex: { renderToString(tex: string, opts?: KatexOptions): string }
    export default katex
}
