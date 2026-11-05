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
