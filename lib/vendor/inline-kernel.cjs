// 把 cm6.js（CodeMirror 6 打包产物）内联进 lib/client.js 末尾。
//
// 为什么要内联：插件只有 exports["./client"] 这一个入口能被浏览器直接加载，
// 内核若走宿主 asset 端点就得多一次网络请求、还要 DSH 重启。内联后 client.js
// 一加载就注册 window.__molingCM —— 没有异步、没有 404、也没有 CSP 风险。
//
// 用法（在插件仓库根目录）：node lib/vendor/inline-kernel.cjs <cm6.js 路径>
const fs = require('node:fs')
const path = require('node:path')

const here = __dirname
const clientPath = path.join(here, '..', 'client.js')
const kernelPath = process.argv[2] || path.join(here, 'cm6.js')

const MARK = '/* ===== 编辑器内核（CodeMirror 6 构建产物，勿手改；重建见 lib/vendor/BUILD.md） ===== */'

const client = fs.readFileSync(clientPath, 'utf8')
const kernel = fs.readFileSync(kernelPath, 'utf8')

// 已经内联过就先切掉旧内核，保证可重复执行
const cut = client.indexOf(MARK)
const base = cut >= 0 ? client.slice(0, cut) : client
if (!base.trimEnd().endsWith('})')) {
  console.error('client.js 结尾不是 }) —— 结构变了，中止')
  process.exit(1)
}

fs.writeFileSync(clientPath, base.trimEnd() + '\n\n' + MARK + '\n;' + kernel.trim() + '\n', 'utf8')
console.log(`已内联 ${Math.round(kernel.length / 1024)} KB → client.js（当前 ${Math.round(fs.statSync(clientPath).size / 1024)} KB）`)
