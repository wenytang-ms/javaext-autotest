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
- `getTerminalText()` — 读取终端输出

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
- `verifyProblems` / `verifyCompletion` / `verifyQuickInput` / `verifyDialog`
- `verifyTreeItem` / `verifyEditorTab` / `verifyOutputChannel` / `verifyTerminal`

### 3.3 结果报告
- 每一步的 pass/fail + 原因
- 失败时附带 before/after/error 截图
- JSON 格式输出（可对接 CI）

---

## Phase 4：LLM 失败分析层

### 4.1 ActionResolver
- 将自然语言 action 映射到 Driver 原语调用
- 提供 regex 操作词典；未匹配时回退到 Command Palette

### 4.2 Azure OpenAI 截图分析
- 当确定性验证失败或步骤报错时，将 before/after 截图发送给 Azure OpenAI
- 使用 `verify` 自然语言描述作为预期上下文
- 返回 reasoning + suggestion；pass/fail 仍由确定性验证决定

### 4.3 汇总分析
- `run-all` 和 `analyze` 可基于多个 `results.json` 生成 `summary.md`
- 已配置 LLM 时为失败计划生成聚合分析

---

## Phase 5：CLI 封装

### 5.1 命令行接口
```bash
# 执行单个 test plan
autotest run test-plans/tree-view.yaml

# 执行所有 test plans
autotest run-all test-plans

# 仅验证 test plan 格式
autotest validate test-plans/tree-view.yaml

# 分析已有 test-results
autotest analyze test-results
```

### 5.2 配置入口

- Test plan 的 `setup` 字段负责 VS Code 版本、扩展、VSIX、workspace/file、settings、workspace trust、mock dialogs 等运行配置。
- LLM 通过环境变量配置：`AZURE_OPENAI_ENDPOINT`、`AZURE_OPENAI_API_KEY`、`AZURE_OPENAI_DEPLOYMENT`、`AZURE_OPENAI_API_VERSION`。
- 报告输出由 CLI `--output` 指定，目录内包含 `results.json`、`screenshots/` 和批量运行的 `summary.md`。
