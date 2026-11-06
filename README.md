# 笔记本（Notebook）2.0

璃鸢镜扩展：`kind: "notebook"`，独立 Tab，打开 / 新建 `.lyrnb` 多笔记包。

## 分层架构

```text
HTML_Reader（阅读器，独立 Tab）
└─ HTML_Editor（编辑器层，无 Tab）
   └─ Notebook（多笔记容器，独立 Tab）
```

Notebook 2.0 不再内置整套编辑器代码：

- 顶层壳：笔记列表、标题、新建/删除、`.lyrnb` 包读写
- 主区域：iframe 嵌入 `html-editor` 层
- 当前笔记 HTML 与 assets 通过 `postMessage` 同步
- 自动保存 `.lyrnb`

## 前置

```json
{ "requires": ["html-reader", "html-editor"] }
```

编辑器层由宿主以固定虚拟域名提供：

```text
https://lyra-extensions.local/html-editor/index.html?embedded=1
```

## `.lyrnb` v2 格式

ZIP：

- `mimetype` = `application/vnd.lyra.notebook+zip`
- `manifest.json`
- `notes/<id>.html`
- `assets/<sha256>.<ext>`

v1 的 `notes/<id>.json` 会在读取时转换为 HTML，下次保存写成 v2。

## 协议

父（Notebook）→ 编辑器：`init` / `set-document` / `request-document`
编辑器 → 父：`ready` / `loaded` / `change` / `document` / `assets`

详见 `FORMAT.md`。

## 许可证

GNU GPL v3.0。

## 2.1.0

- 笔记默认使用完整 HTML 文档：`<!DOCTYPE html>` + `html/head/meta/title/style/body`。
- 旧笔记的 HTML 片段加载时自动补全为完整文档，保存时写回完整文档。
- 顶部新增「编辑 / 阅读」切换；阅读模式使用独立 iframe，不显示 DevTool。
- 阅读模式会把 `.lyrnb` 里的 assets 转成 data URL，图片正常显示。

## 2.2.0

- 阅读模式增加字号 A−/A+、浅色/护眼/深色主题、窄/中/宽阅读宽度，设置写入 `.lyrnb`。
- 笔记支持上移/下移、复制（复制为完整 HTML 文档）。

## 2.3.0

- 阅读模式不再注入字号、主题、宽度或 body 样式；完整 HTML 原样渲染，`body` 自己的 `color`、`width`、字体全部保留。
- 移除阅读调字号/主题/宽度控件。

## 2.3.1

- 编辑器 iframe 增加版本 query，避免加载缓存的旧 HTML_Editor。

## 2.3.2

- 编辑器 iframe 缓存版本更新到 140，加载 HTML_Editor 1.4.0。

## 2.3.3

- 编辑器缓存版本更新到 150，加载 HTML_Editor 1.5.0。

## 2.3.17

- 编辑/阅读 iframe 增加 allow="autoplay"；编辑器缓存 280。


## 2.3.18

- 嵌入编辑器缓存版本 281（Editor 1.17.2，含 Console/资源引用计数）。
- 需要主程序 1.4.6+。

## 2.3.19

- 编辑器缓存 282。

## 2.3.20

- 编辑器缓存 283。

## 2.3.21

- 编辑器缓存 284。

## 2.3.22

- 编辑器缓存 285。

## 2.3.23

- 顶栏新增笔记搜索：按标题/正文过滤，结果显示标题和命中片段，点击切换笔记；Enter 选第一个，Esc 关闭。

## 2.3.24

- 编辑器缓存 286。

## 2.3.25

- 编辑器缓存 287。

## 2.3.26

- 编辑器缓存 288。

## 2.3.27

- 编辑器缓存 289。
