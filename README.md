# HTML 笔记本扩展

璃鸢镜的本地优先笔记本扩展。一个 `.lyrnb` 文件包含多篇笔记。

## 当前版本

- 左侧「笔记」Tab：打开已有 `.lyrnb` / 新建笔记本
- 一个笔记本内多篇笔记
- 三栏编辑器：左 HTML 源码、中实时预览、右 Dev Tool 调参
- CodeMirror 5 HTML/CSS/JS 语法高亮、行号、括号匹配、标签自动闭合
- 基础补全：Ctrl+Space 手动触发，输入 `<`、空格、`=`、引号时自动提示
- 源码修改后自动热重载预览
- Dev Tool 四个标签：Style / CSS / DOM / Assets
- CSS：管理 `<style data-lyra-devtool>` 规则，支持 :hover / :focus / :active / ::before / ::after
- DOM Tree：树形浏览预览 DOM，支持搜索和折叠，点节点选中并跳到源码行
- Assets：列出 `.lyrnb` 内的图片资源，可预览、插入、复制路径、删除
- 检查元素：点击预览元素，左侧跳到对应源码行
- 95 个 CSS 属性控件（Layout / Flex+Grid / Size / Spacing / Typography / Background+Border / Effects）+ 任意自定义属性，全部英文属性名
- 右侧可调 flex/grid 布局、子元素对齐、间距、字体、颜色、圆角、变换、过渡、滤镜等，修改直接写回源码 inline style
- 图片：Image 按钮选择本地图片，按 SHA-256 存入 `.lyrnb` 的 `assets/`，源码插入 `<img src="assets/...">`
- Format 按钮 / Shift+Alt+F 格式化 HTML
- Attributes 面板可改元素 id / class
- 一个笔记就是一段 HTML/CSS，不再受自定义块语法限制
- 一个 `.lyrnb` 仍包含多篇 HTML 笔记，支持旧版块格式自动迁移
- 自动保存，宿主原子写回
- `.lyrnb` 结构：ZIP + `manifest.json` + 每篇笔记一个 `notes/<id>.html` + `assets/`

## 说明

- 每篇笔记现在就是 HTML/CSS 源码；右侧 Dev Tool 修改的是该元素源码里的 style 属性。
- 预览在沙箱 iframe 中运行，检查器只在预览 DOM 临时加标记，不会写进 `.lyrnb`。
- 旧版结构化块 `.lyrnb` 会在打开时自动转换成 HTML，保存后成为 v2 格式。
- 详细格式见 `FORMAT.md`。
