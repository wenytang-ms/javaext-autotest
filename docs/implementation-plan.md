# 实现计划

## Phase 1：基础框架搭建

### 1.1 项目初始化
- 初始化 npm 项目，配置 TypeScript
- 安装核心依赖：`@playwright/test`, `@vscode/test-electron`, `commander`, `js-yaml`
- 配置 tsconfig、eslint

### 1.2 VscodeDriver 核心
- 实现 VSCode 启动/关闭（Playwright Electron）
- 实现 `runCommand()` — 执行 VSCode 命令
- 实现 `runCommandFromPalette()` — Command Palette 操作
- 实现 `snapshot()` — 获取 A11y 树
- 实现 `screenshot()` — 截图

### 1.3 基础验证能力
- `isElementVisible()` — 元素可见性检查
- `getNotifications()` — 读取通知
- `fileExists()` / `fileContains()` — 文件系统验证

---

## Phase 2：操作原语完善

### 2.1 编辑器操作
- `openFile()` — 打开文件
- `getEditorContent()` / `setEditorContent()` — 读写编辑器
- `saveFile()` — 保存文件

### 2.2 UI 交互
- `activeSideTab()` — 切换侧边栏
- `clickTreeItem()` / `expandTreeItem()` — TreeView 操作
- `selectPaletteOption()` — Command Palette 选项选择

### 2.3 终端操作
- `runInTerminal()` — 在集成终端执行命令
- `getTerminalOutput()` — 读取终端输出

---

## Phase 3：Test Plan 引擎

### 3.1 Plan 解析器
- YAML Test Plan 解析
- Setup 阶段执行（配置注入、扩展加载等待）
- Step 顺序执行框架

### 3.2 确定性验证引擎
- `verifyFile` — 文件验证
- `verifyNotification` — 通知验证
- `verifyEditor` — 编辑器内容验证
- `verifyElement` — 元素可见性验证

### 3.3 结果报告
- 每一步的 pass/fail + 原因
- 失败时附带 snapshot 和截图
- JSON 格式输出（可对接 CI）

---

## Phase 4：AI 集成层

### 4.1 Action 理解
- 将自然语言 action 映射到 Driver 原语调用序列
- 提供"操作词典"（常见操作的标准映射）

### 4.2 AI Snapshot 验证
- 将 A11y snapshot 发送给 AI
- AI 判断当前 UI 状态是否满足 `verify` 描述
- 返回 pass/fail + reasoning

### 4.3 自适应执行
- 当标准映射失败时，AI 读 snapshot 自行规划操作
- 重试机制：操作失败后 AI 尝试替代方案

---

## Phase 5：CLI 封装

### 5.1 命令行接口
```bash
# 执行单个 test plan
autotest run test-plans/tree-view.yaml

# 执行所有 test plans
autotest run test-plans/

# 连接已运行的 VSCode（调试模式）
autotest run test-plans/tree-view.yaml --attach 9222

# 仅验证 test plan 格式
autotest validate test-plans/tree-view.yaml

# 交互模式：逐步执行 + 手动确认
autotest run test-plans/tree-view.yaml --interactive
```

### 5.2 配置文件
```yaml
# autotest.config.yaml
vscode:
  version: "insiders"
  extensions:
    - "./path/to/my-extension"
  settings:
    editor.fontSize: 14
ai:
  provider: "copilot"    # copilot | openai | azure-openai
  model: "gpt-4"
report:
  format: "json"         # json | html | console
  outputDir: "./test-results"
```
