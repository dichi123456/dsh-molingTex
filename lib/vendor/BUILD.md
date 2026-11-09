# 编辑器内核（CodeMirror 6）

`cm6.js` 是本目录里唯一被打包好的产物，`entry.js` 是它的源码。插件在浏览器里用

```
/moling/api/asset?name=cm6.js&v=<KERNEL_VERSION>
```

把它当普通 `<script>` 加载，加载完挂在 `window.__molingCM` 上（见 `entry.js` 末尾）。

## 重新构建

```bash
mkdir cm-build && cd cm-build
npm init -y
npm i codemirror@^6 @codemirror/state @codemirror/view @codemirror/commands \
      @codemirror/language @codemirror/search @codemirror/legacy-modes @lezer/highlight
npm i -D esbuild

# entry.js 从本目录拷过来
cp ../entry.js .
npx esbuild entry.js --bundle --format=iife --minify --target=chrome110 --outfile=cm6.js
cp cm6.js <插件目录>/lib/vendor/cm6.js
```

然后把 `lib/client.js` 里的 `KERNEL_VERSION` 加一（打掉浏览器缓存），重开 DSH。

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
