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
- DOM 编辑：选中节点后可重命名标签、删除整个元素，操作直接改 HTML 源码
- Assets：图片缩略图、Insert、Replace、Copy path、Delete，并显示引用次数
- 引用检查：查找缺失资源和未使用资源
- 预览支持 Responsive / 1440 / 1024 / 768 / 390 宽度
- 检查元素：点击预览元素，左侧跳到对应源码行；点击图片时选中的就是图片本身
- Alt+Click 选中父容器；右侧 Actions 还有 Select parent 按钮
- 格式化：长标签每个属性缩进 2 格，style 属性内声明缩进 4 格逐条换行
- 源码光标同步：左边光标落在哪个元素里，右边 Dev Tool 自动显示哪个元素，不需要先 Inspect
- 全量 CSS 属性补全：搜索浏览器实际支持并通过 CSS.supports 校验的 564 个有效属性，像 WebStorm 一样输入过滤、方向键选择、Enter 应用
- Inline style 列表：选中元素的所有 inline 声明逐条编辑/删除，任意属性都能加
- 属性值补全：display/flex/字体/背景/边框等常用值 + 通用关键字和单位提示
- 移除固定 Quick properties 面板，避免和搜索结果重复；所有属性统一走搜索 + inline style 列表
- 右侧可调 flex/grid 布局、子元素对齐、间距、字体、颜色、圆角、变换、过渡、滤镜等，修改直接写回源码 inline style
- 图片：Image 按钮选择本地图片，按 SHA-256 存入 `.lyrnb` 的 `assets/`，源码插入 `<img src="assets/...">`
- Format 按钮 / Shift+Alt+F 格式化 HTML：长标签属性逐行缩进 2 格，style 属性里的声明缩进 4 格逐条换行
- 源码编辑器启用软换行，长行不再需要横向滚动
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

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

Third-party components retain their own licenses (CodeMirror: MIT, JSZip: MIT/GPLv3, js-beautify: MIT).
