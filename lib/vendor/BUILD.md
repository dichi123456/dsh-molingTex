# 编辑器内核（CodeMirror 6）

`cm6.js` 是打包产物，`entry.js` 是它的源码。

**交付方式：内联**。`cm6.js` 由 `inline-kernel.cjs` 拼进 `lib/client.js` 末尾
（末尾带常量 `KERNEL_VERSION` 与注释标记，重复执行会先切掉旧内核）。这样浏览器加载
client.js 时就注册好 `window.__molingCM`，不需要额外网络请求、不需要重启 DSH、
也没有 CSP 拦截动态脚本的风险。

`lib/client.js` 里的 `loadEditorKernel()` 仍保留为兜底/调试路径（走宿主的
`/moling/api/asset?name=cm6.js`）；内核已内联时它会直接短路，不会真的发请求。

## 重新构建

```bash
mkdir cm-build && cd cm-build
npm init -y
npm i codemirror@^6 @codemirror/state @codemirror/view @codemirror/commands \
      @codemirror/language @codemirror/search @codemirror/legacy-modes @lezer/highlight
npm i -D esbuild

cp <插件目录>/lib/vendor/entry.js .
npx esbuild entry.js --bundle --format=iife --minify --target=chrome110 --outfile=cm6.js

cp cm6.js <插件目录>/lib/vendor/cm6.js
cd <插件目录>
node lib/vendor/inline-kernel.cjs          # 内联进 lib/client.js
```

改完 `lib/client.js` 走 HMR：**刷新页面即可，不用重开 DSH**。
（`KERNEL_VERSION` 也顺手加一，供走 asset 端点调试时打掉浏览器缓存。）

## 为什么不用 `@codemirror/lang-latex`

当前 npm registry 上取不到（404）。改用 `@codemirror/legacy-modes/mode/stex`
——CodeMirror 5 时代的 LaTeX 模式，配 `StreamLanguage` 一样有命令/环境/数学/注释 token。

## 对外 API（`window.__molingCM`）

| 方法 | 说明 |
| --- | --- |
| `create(parent, opts)` | `opts = {doc, wrap, autofocus, onChange(text), onSave(), onCompile()}`，返回 `EditorView` |
| `setDoc(view, text)` | 外部替换整篇（不触发 `onChange`） |
| `getDoc(view)` | 取当前文本 |
| `setWrap(view, on)` | 软换行开关（`Compartment` 重配） |
| `setReadOnly(view, on)` | 只读 |
| `gotoLine(view, line)` | 跳到第 `line` 行（1 起）并居中 |
| `focus` / `destroy` / `undo` / `redo` | 常规 |

主题全部用 DSH 的 `--dsw-alias-*` 变量，因此亮/暗自动跟随，不需要额外的主题切换代码。
