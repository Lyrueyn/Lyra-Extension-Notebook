# HTML 笔记本扩展

璃鸢镜的本地优先笔记本扩展。一个 `.lyrnb` 文件包含多篇笔记。

## 当前版本

- 左侧「笔记」Tab：打开已有 `.lyrnb` / 新建笔记本
- 一个笔记本内多篇笔记
- 三栏编辑器：左 HTML 源码、中实时预览、右 Dev Tool 调参
- 源码修改后自动热重载预览
- Dev Tool 检查元素：点击预览元素，左侧跳到对应源码行，右侧调 style/布局/子元素对齐
- 一个笔记就是一段 HTML/CSS，不再受自定义块语法限制
- 一个 `.lyrnb` 仍包含多篇 HTML 笔记，支持旧版块格式自动迁移
- 自动保存，宿主原子写回
- `.lyrnb` 结构：ZIP + `manifest.json` + 每篇笔记一个 `notes/<id>.html` + `assets/`

## 说明

- 每篇笔记现在就是 HTML/CSS 源码；右侧 Dev Tool 修改的是该元素源码里的 style 属性。
- 预览在沙箱 iframe 中运行，检查器只在预览 DOM 临时加标记，不会写进 `.lyrnb`。
- 旧版结构化块 `.lyrnb` 会在打开时自动转换成 HTML，保存后成为 v2 格式。
- 详细格式见 `FORMAT.md`。
