import { configDefaults, defineConfig } from 'vitest/config'

/*
 * 浏览器用的那份独立配置目录（.userdata，启动器建的）里装着 Chrome 扩展自带的
 * *.test.js —— vitest 默认会去收集它们，当场冒出 52 个 "describe is not defined"，
 * 把真红混在假红里。启动器已经改把 profile 放去 %LOCALAPPDATA%，这条是第二道闸：
 * 以后谁再把这类目录挪回头里，测试也不会被污染。
 */
export default defineConfig({
    test: { exclude: [...configDefaults.exclude, '**/.userdata/**'] },
})
