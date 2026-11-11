# dsh-plugin-moling-latex

**墨灵 LaTeX 的 DSH 插件**：在 DSH 右侧栏打开墨灵TeX 工作台 —— 目录树 · 编辑 · 编译 · 日志 · PDF 预览 · SyncTeX 双向定位；另带 5 个 Agent 工具，让模型直接编译论文、读报错、定位源码行。

## 安装

### DSH 界面安装

设置 → 插件 → 右上「添加插件」，输入框填：

```
github:dichi123456/dsh-molingTex
```

输入框支持 **包名 / GitHub 仓库地址 / 本地目录路径** 三种；GitHub 源装的是 `main` 最新提交。

### 指定版本（Release 安装包）

```
plugin_manager install_bundle  https://github.com/dichi123456/dsh-molingTex/releases/download/v0.6.1/dsh-plugin-moling-latex-0.6.1.tgz
```

### 本地目录

```
plugin_manager install_bundle  <本仓库本地路径>
```

- 装完**重开 DSH**（宿主半侧要加载）；
- 需要本机 TeX 发行版（TeX Live / MiKTeX）；PDF 预览与双向定位用 TeX 自带的 poppler `pdftoppm` 与 `synctex`；
- 已装同版本会返回 `already-installed`：先 `remove_bundle` 再 `install_bundle`；
- 发布页：<https://github.com/dichi123456/dsh-molingTex/releases>

## 能做什么

**启动页**：进来先看「最近」—— 工作区与文件分两组、各最多 5 条，点一个才进工作台；不自动打开任何项目。

**工作台**

- 左侧 **CodeMirror 6** 编辑器：LaTeX 语法高亮、行号、软换行、多标签；`F5` 编译、`Ctrl+S` 保存、`Ctrl+F` 搜索；
- **进入项目文件夹自动打开 `main.tex`**（项目里没有 .tex 就什么都不开）；
- 顶栏：`首页`、工作区切换、`树 | 提纲`、`换行 | 保存 | 新建`、连接状态胶囊、分体编译按钮（左键即编译，小三角切 快速 / 完整 / 从头）；
- `树`：浮层文件树，右边框可拖；`提纲`：章节列表点一条跳一行；
- 底部状态栏：编译结果居中显示（成功绿 / 失败红），最右切换 `日志` / `PDF`。

**PDF 预览**：逐页图片，轻量不卡；清晰度 72 / 96 / 144 三档，`Ctrl+滚轮` 以鼠标为锚点缩放（0.5×–3×），`适应` 一键整页贴合当前窗口；**单击页面跳回源码行**。

**SyncTeX 双向定位**：编辑器右键「定位到 PDF 位置」→ 源码行跳到 PDF 对应页并画黄圈；PDF 上单击 → 跳回源码行；结果显示在底部状态栏。

**与对话框联动**

- **连接状态胶囊**：项目是否已在 DSH 工作区（绿 / 黄 / 灰），未连接时点一下直接加入；
- **发送选中内容**：编辑器右键把选区连同行号送进当前会话的输入框（不自动发送）。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `latex_compile` | 编译 `.tex`。`quick` 单趟 draft；`full` 主编译 →（需要时）bibtex → 再编译 → 视 Rerun 提示补一趟；`clean` 先清辅助文件再走 full |
| `latex_status` | TeX Live / MiKTeX 探测：bin 目录、版本、六个引擎路径 |
| `latex_synctex` | SyncTeX 双向同步：源码行 → PDF 坐标；PDF 坐标 → 源码行 |
| `latex_clean` | 删除 `.aux/.log/.toc/.out/.bbl/.synctex.gz/...`（不碰 `.tex/.pdf/.bib`） |
| `latex_outline` | 章节标题与行号、`\input`/`\include` 依赖、`\label`/`\cite` 计数 |

引擎缺省 `auto`：`ctex`/中文 → `xelatex`；`IEEEtran`/`elsarticle`/`article` → `pdflatex`。

## 排错

| 现象 | 处理 |
| --- | --- |
| 右侧栏没有「墨灵 LaTeX」入口 | 插件没挂载：`plugin_manager list_bundles` 看有没有 `dsh-plugin-moling-latex`，没有就重装 |
| 面板状态灯是红的 | 数据通道异常：确认 `GET /moling/api/ping` 能返回 `{"ok":true,...}`，否则是宿主半侧没装载 |
| 打开文件夹后列表是空的 | 列表区会写原因：`不在允许范围内` → 用启动页「打开文件夹…」重开一次；`另有 N 个其它文件` → 该目录确实没有支持的类型 |
| 编译报「找不到引擎」 | 让 Agent 跑 `latex_status`，或在插件配置里指 `texlivePath` |
| PDF 预览空白 | 先看底部状态条：写「降分辨率预览不可用」= 取图失败（已退回内置阅读器）；两样都空就点「新标签」用系统/浏览器打开 |
| 改了代码后面板没变化 | 只改 `lib/client.js` 刷新页面即可；改 `lib/server.js` / `lib/index.js` 要**重开 DSH** |

## 许可证

MIT © [dichi123456](https://github.com/dichi123456)
