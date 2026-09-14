# 轻量思维导图（Light-weight Mind Map）

一个 VSCode 插件，提供轻量级思维导图的编辑体验：中心主题 + 左右分支、彩色贝塞尔连线、节点折叠 / 展开、拖拽调整结构、键盘快速编辑、撤销 / 重做、自动保存，并支持导出 Markdown / HTML / PNG。

## 功能

- **自定义编辑器**：双击打开 `.mindmap` / `.mindm` 文件即进入轻量级思维导图画布；修改自动保存（约 0.8s 防抖）。
- **类飞书布局**：根节点居中，一级分支左右交替，分支颜色自动分配，树状分叉连线（父节点中点水平延伸 → 垂直骨干 → 分叉到各子节点）。
- **文字居中**：节点内文字水平、垂直双居中；缩放采用 CSS zoom 渲染，放大后文字依然清晰。
- **节点操作**
  - `Tab` 添加子主题；`Enter` 添加同级（`Shift+Enter` 添加在前面）
  - `Shift+Tab` 提升层级（升级为父节点的同级）
  - `F2` / 双击 编辑文本（`Enter` 提交，`Shift+Enter` 换行，`Esc` 取消）
  - `Del` / `Backspace` 删除（子节点自动提升为同级）
  - 拖拽节点到目标节点中部 = 成为其子节点；拖到上 / 下缘 = 成为其前 / 后同级
  - 点击节点上的圆点折叠 / 展开；`←` `→` 也可折叠 / 展开 / 导航
- **导航与视图**：`↑ ↓ ← →` 方向键移动选中；滚轮平移、`Ctrl+滚轮` 缩放、拖拽空白处平移；工具栏一键「适应窗口」。
- **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Y`（或 `Ctrl+Shift+Z`）。
- **主题**：飞书彩色 / 清新绿 / 深色夜间，可在画布右上角切换；默认主题在设置 `mindmap.defaultTheme` 中配置。
- **导出**：Markdown（层级列表）、独立可交互 HTML、PNG 高清图片。

## 使用

1. 在 VSCode 中安装本插件（`.vsix`：扩展视图 → 右上角 `...` → 从 VSIX 安装）。
2. 按 `Ctrl+Alt+M`（macOS `Cmd+Alt+M`）新建思维导图；或在资源管理器中右键文件夹选择「在此新建思维导图」。
3. 打开任意 `.mindmap` / `.mindm` 文件，开始编辑。

## 文件格式

`.mindmap` 是带版本的 JSON：

```json
{
  "version": 1,
  "meta": { "createdBy": "feishu-style-mindmap", "createdAt": "..." },
  "root": {
    "id": "n1",
    "text": "中心主题",
    "collapsed": false,
    "children": [
      { "id": "n2", "text": "分支一", "collapsed": false, "children": [] }
    ]
  }
}
```

## 开发

```bash
npm install        # 安装依赖
npm run compile    # TypeScript 编译到 dist/
npm test           # 运行核心逻辑单测（Node，无 VSCode 依赖）
npm run package    # 打包 .vsix（需要 npx @vscode/vsce）
```

调试：在 VSCode 中打开本项目，按 `F5` 启动「扩展开发宿主」，即可在宿主机中 `Ctrl+Alt+M` 试用手感。

### 目录结构

```
├── src/                  # 扩展宿主端（TypeScript）
│   ├── extension.ts          # 激活入口、新建命令
│   └── mindmapEditorProvider.ts  # 自定义编辑器 Provider（打开/保存/导出）
├── media/                # Webview 端
│   ├── core.js               # 纯逻辑：模型/布局/序列化/导出（可单测）
│   ├── mindmap.js            # UI：渲染/交互/拖拽/缩放/编辑
│   └── style.css             # 轻量级风格样式
├── test/core.test.js      # 核心逻辑单测
└── package.json
```

## 已知限制

- 不支持节点图标、富文本、备注（如需要可继续扩展 `.mindmap` 格式）。
- 导出 PNG 的分辨率上限 4096px（长边）。
