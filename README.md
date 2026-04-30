# VSCode AutoTest

AI 驱动的 VSCode 扩展 E2E 测试框架。

用户提供 YAML 格式的 Test Plan → 框架自动启动 VSCode → 执行操作 → 验证结果。

> **目标**：用声明式 YAML Test Plan 自动完成 VSCode 扩展端到端测试，并让 Copilot CLI 能直接运行、分析和修复测试计划。

---

## 快速开始

```bash
# 安装依赖
npm install

# 编译
npm run build

# 验证 test plan 格式
npx autotest validate test-plans/java-maven.yaml

# 执行测试（默认输出到 test-results/<plan-name>/）
npx autotest run test-plans/java-maven.yaml

# 指定输出目录（包含 results.json + screenshots/）
npx autotest run test-plans/java-maven.yaml --output test-results/java-maven

# 批量运行并生成汇总
npx autotest run-all test-plans --exclude java-fresh-import

# 重新分析已有 test-results
npx autotest analyze test-results
```

### 前置条件

- Node.js ≥ 18
- JDK 已安装（测试 Java 扩展时需要）
- vscode-java 仓库已 clone 到本地（test plan 中引用了其测试项目）

---

## 核心架构

```
┌─────────────────────────────────────────────────────┐
│                  Test Plan (YAML)                    │
│  描述测试步骤 + 预期结果，不包含硬编码 locator        │
└──────────────────┬──────────────────────────────────┘
                   │  planParser.ts
                   ▼
┌─────────────────────────────────────────────────────┐
│              TestRunner (编排层)                      │
│  启动 VSCode → 逐步执行 → 截图 → 报告               │
│                                                     │
│  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │  ActionResolver   │  │     StepVerifier        │  │
│  │  Action → Driver  │  │  确定性验证             │  │
│  │  (50+ regex)      │  │  (10 种策略)            │  │
│  └────────┬─────────┘  └──────────┬──────────────┘  │
│           │                       │                  │
│           │              ┌────────┴────────┐         │
│           │              │    LLMClient    │         │
│           │              │  Azure OpenAI   │         │
│           │              │  失败截图分析   │         │
│           │              └─────────────────┘         │
└───────────┼──────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────┐
│           VscodeDriver (操作原语 SDK)                 │
│  基于 Playwright Electron + @vscode/test-electron    │
│  工作区隔离 · 事件驱动等待 · 进程生命周期管理          │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│           Playwright Electron Runtime                │
│  启动 VSCode 进程，提供 Page 对象                    │
└─────────────────────────────────────────────────────┘
```

---

## 编写 Test Plan

### 基本结构

```yaml
name: "我的测试"
setup:
  extension: "my-extension"       # Marketplace 扩展 ID；也会作为 primary extension 安装
  extensionPath: "./path/to/extension"
  extensions: ["publisher.other-extension"]
  vsix: ["./dist/my-extension.vsix"]
  vscodeVersion: "stable"
  workspace: "./test-workspace"   # 相对于 test plan 文件的路径
  # file: "./Single.java"          # 单文件无 workspace 模式
  # repos: [{ url: "https://github.com/org/repo.git", path: "./repo", branch: "main" }]
  timeout: 60
  settings:                       # 可选：注入 VSCode settings
    editor.fontSize: 14
  workspaceSettings:              # 可选：写入 <workspace>/.vscode/settings.json
    java.configuration.updateBuildConfiguration: "automatic"
  workspaceTrust: "disabled"      # disabled | trusted | untrusted
  mockOpenDialog:                 # 可选：mock native open/save dialog 返回值
    - ["~/lib/example.jar"]

steps:
  - id: "step-1"
    action: "执行命令 My Extension: Hello"
    verifyNotification: "Hello World!"
```

> **路径解析**：`extensionPath`、`extensionPaths`、`localExtensions`、`workspace`、`file`、`vsix`、`repos[].path` 和非 `~/` 的 `mockOpenDialog` 路径都相对于 test plan 文件所在目录解析，不依赖 CWD。`~/` 在运行时表示临时 workspace root。

### 支持的 Action（自然语言 → Driver 映射）

ActionResolver 使用确定性 regex 字典；未匹配的 action 会作为 Command Palette 文本执行。

| 类别 | Action 写法 | 说明 |
|------|-------------|------|
| 命令/按键 | `run command <name>`、`selectCommand <name>`、`executeVSCodeCommand <id> [jsonArg]`、`pressKey <key>`、`pressTerminalKey <key>` | 执行命令面板、VS Code command ID 或键盘操作 |
| 文件/编辑器 | `open file <name>`、`saveFile`、`insertLineInFile <path> <line> <text>`、`deleteFile <path>`、`typeInEditor <text>`、`typeAndTriggerSnippet <word>` | 打开/保存/删除文件，或写入编辑器内容；LS 相关修改优先用 `insertLineInFile` |
| 导航/代码智能 | `waitForLanguageServer`、`goToLine <n>`、`goToEndOfLine`、`findText <text>`、`navigateToError <n>`、`applyCodeAction <label>`、`renameSymbol <newName>`、`organizeImports`、`triggerCompletion`、`triggerCompletionAt <place>`、`hoverOnText <text>`、`dismissHover` | Java LS、Problems、Code Action、补全、重命名、Hover |
| Workbench UI | `click side tab <name>`、`collapseSidebarSection <name>`、`collapseWorkspaceRoot`、`select <name> option`、`selectOptionByIndex <n>`、`wait <n> seconds` | 侧边栏、Quick Pick 和静态等待 |
| TreeView | `click <name> tree item`、`expandTreeItem <name>`、`doubleClick <name> tree item`、`clickTreeItemAction <item> <label>`、`contextMenu <item> <menuLabel>`、`createNewFile <folder> <name>`、`openDependencyExplorer` | 树节点点击/展开/双击、inline action、右键菜单和 Java Dependencies |
| Quick Input/Dialog | `fillQuickInput <text>`、`fillAnyInput <text>`、`typeInQuickInput <text>`、`confirmQuickInput`、`dismissQuickInput`、`waitForDialog [seconds]`、`clickDialogButton <label>`、`tryClickDialogButton <label>`、`confirmDialog`、`tryClickButton <label>` | 输入框、inline rename 和 modal dialog |
| Debug/Test Runner | `startDebugSession`、`stopDebugSession`、`setBreakpoint <line>`、`debugStepOver`、`debugStepInto`、`debugStepOut`、`openTestExplorer`、`waitForTestDiscovery <name> [timeout]s`、`runAllTests`、`runTestsWithProfile <profile>`、`clickCodeLens <label>` | Java Debugger 和 Java Test Runner 场景 |

### 支持的验证方式

| 字段 | 类型 | 说明 |
|------|------|------|
| `verify` | string | 自然语言预期；当前用于失败后的 LLM 截图分析上下文，不单独决定 pass/fail |
| `verifyFile` | object | 文件存在性 / 内容匹配，支持 `path`、`exists`、`contains` |
| `verifyNotification` | string | 通知消息匹配 |
| `verifyEditor` | object | 编辑器内容匹配，常用 `contains` |
| `verifyProblems` | object | Problems 面板错误/警告计数，支持 `errors`、`warnings`、`atLeast` 和轮询等待 |
| `verifyCompletion` | object | 代码补全列表验证，支持 `notEmpty`、`contains`、`excludes` |
| `verifyQuickInput` | object | Quick Input 校验消息，支持 `noError`、`messageContains`、`messageExcludes` |
| `verifyDialog` | object | Modal dialog 可见性和内容，支持 `visible`、`contains` |
| `verifyTreeItem` | object | Tree item 出现/消失，支持 `name`、`visible`、`exact` |
| `verifyEditorTab` | object | Editor tab 标题出现 |
| `verifyOutputChannel` | object | Output channel 文本匹配，支持 `channel`、`contains`、`notContains` |
| `verifyTerminal` | object | Terminal 文本匹配，支持 `contains`、`notContains` |

---

## 测试隔离与截图

### 工作区隔离

每次运行自动将 `workspace` 复制到固定临时目录 (`autotest-workspace/`)，测试结束后清理。原始工作区**永远不会被修改**。

### 截图策略

每个步骤自动截图，保存到输出目录的 `screenshots/` 子目录中（默认 `test-results/<plan-name>/screenshots/`，可通过 `--output` 改变输出根目录）：

| 步骤状态 | 截图文件 |
|---------|---------|
| ✅ pass | `NN_<stepId>_before.png` + `NN_<stepId>_after.png` |
| ❌ fail / error | `NN_<stepId>_before.png` + `NN_<stepId>_after.png` 或 `NN_<stepId>_error.png` |

### 进程管理

- 每次启动前自动清空 VSCode user-data 目录，防止旧窗口恢复
- Ctrl+C 中断时自动关闭 VSCode 进程
- `close()` 带重试机制处理 Windows 文件锁

---

## LLM 失败分析（可选）

LLM 是可选的失败分析层：当某个步骤的确定性验证失败或报错，框架会把 before/after 截图、action 和 `verify` 描述发送给 Azure OpenAI，生成原因分析和修复建议。`verify` 本身不会替代确定性验证，也不会单独决定步骤是否通过。

```yaml
- id: "check-ls"
  action: "waitForLanguageServer"
  verify: "状态栏显示 Java 语言服务器已就绪（👍 图标）"   # 失败时作为 LLM 分析上下文
  verifyProblems:                                        # 确定性验证决定 pass/fail
    errors: 0
```

配置环境变量启用：

```bash
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
export AZURE_OPENAI_API_KEY=<key>
export AZURE_OPENAI_DEPLOYMENT=gpt-4.1       # 可选，默认 gpt-4.1
export AZURE_OPENAI_API_VERSION=2024-12-01-preview
```

- 未配置时跳过 LLM 分析，确定性验证不受影响
- `--no-llm` 强制跳过 LLM 分析

---

## TreeView inline action 场景

VS Code 的 TreeView inline action（例如节点右侧的 Run / Add / New 图标）通常只在 hover、focus 或 selected 时显示。不要用固定坐标点击图标，使用 `clickTreeItemAction <item> <label>`：

```yaml
- action: "expandTreeItem Lifecycle"
- action: "clickTreeItemAction compile Run"
```

如果目标 view 被 Explorer、Outline、Timeline、Java Projects 等 section 挤到不可见，先折叠占空间的区域，再 focus 目标 view：

```yaml
- action: "collapseWorkspaceRoot"
- action: "collapseSidebarSection OUTLINE"
- action: "collapseSidebarSection TIMELINE"
- action: "run command Maven: Focus on Maven Projects View"
```

---

## Copilot CLI 集成

本项目提供 `AGENTS.md`，Copilot CLI 在此目录下可直接运行测试：

```
> 运行 java-maven 测试
```

Copilot CLI 会自动执行 `npx autotest run`，读取结果和截图，分析失败原因。

详见 [AGENTS.md](AGENTS.md)。

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `npx autotest run <plan>` | 运行单个 YAML test plan，默认输出到 `test-results/<plan-name>/` |
| `npx autotest run-all <dir>` | 运行目录下所有 `.yaml/.yml` test plan，并生成 `summary.md` |
| `npx autotest analyze <dir>` | 扫描已有 `results.json` 并重新生成汇总 / LLM 分析 |
| `npx autotest validate <plan>` | 校验 YAML test plan 格式 |

常用选项：

| 选项 | 适用命令 | 说明 |
|------|----------|------|
| `--output <dir>` | `run` / `run-all` / `analyze` | 指定输出目录 |
| `--no-llm` | `run` / `run-all` / `analyze` | 跳过 LLM 失败分析 |
| `--vsix <paths>` | `run` / `run-all` | 逗号分隔的 VSIX 路径，追加安装到 plan 的 `setup.vsix` |
| `--override <kv...>` | `run` / `run-all` | 覆盖 `setup` 字段，例如 `--override extensionPath=../../vscode-java` |
| `--exclude <plans>` | `run-all` | 逗号分隔的 plan 名称，默认排除 `java-fresh-import` |

---

## 现有 Test Plan

| 文件 | 步数 | 场景 |
|------|------|------|
| `annotation-completion-before.yaml` | 6 | Annotation completion 基线 |
| `java-annotation-completion-bug.yaml` | 6 | Annotation completion 回归 |
| `java-basic-editing.yaml` | 21 | Basic editing、snippet、Code Action、Rename、Import、Explorer |
| `java-debugger.yaml` | 9 | 断点、启动调试、单步、停止 |
| `java-dependency-viewer.yaml` | 7 | Java Dependencies / TreeView |
| `java-extension-pack.yaml` | 3 | Java Extension Pack / Configure Classpath |
| `java-fresh-import.yaml` | 3 | Fresh import / Spring Petclinic |
| `java-gradle-delegate-test.yaml` | 15 | Gradle delegate test |
| `java-gradle-java25.yaml` | 6 | Gradle Java 25 |
| `java-gradle.yaml` | 7 | Gradle LS、补全、导航、编辑 |
| `java-maven-java25.yaml` | 6 | Maven Java 25 |
| `java-maven-multimodule.yaml` | 5 | Maven multi-module |
| `java-maven-resolve-type.yaml` | 6 | Maven resolve type / Code Action |
| `java-maven.yaml` | 7 | Maven LS、补全、导航、编辑、诊断 |
| `java-new-file-snippet.yaml` | 4 | 新建 Java 文件 + class snippet |
| `java-single-file.yaml` | 6 | 单文件 Java |
| `java-single-no-workspace.yaml` | 6 | 无 workspace 单文件 Java |
| `java-test-runner.yaml` | 6 | Java Test Runner |
| `java-unicode-classname-789.yaml` | 6 | Unicode class name 回归 |
| `maven-workspace-trust.yaml` | 5 | Maven workspace trust |

### Wiki 场景覆盖情况

| Wiki 场景 | 状态 | 阻碍 |
|-----------|------|------|
| Basic #1-5 | ✅ 已有 test plan | — |
| Basic #6-8 (补全/Import/Rename) | ✅ 已有 test plan | — |
| Basic #9 (New Java File snippet) | ✅ 已有 test plan | — |
| Maven | ✅ 已有 test plan | — |
| Maven Multimodule | ✅ 已有 test plan | — |
| Gradle | ✅ 已有 test plan | — |
| Maven Java 25 | ✅ 已有 test plan | — |
| Gradle Java 25 | ✅ 已有 test plan | — |
| Single file | ✅ 已有 test plan | — |
| Single file without workspace | ✅ 已有 test plan | `file` 单文件模式 |
| Fresh import (spring-petclinic) | ✅ 已有 test plan | 需要提前 clone 项目 |
| Debugger for Java | ✅ 已有 test plan | — |
| Java Test Runner | ✅ 已有 test plan | — |
| Maven for Java | ✅ 已有 test plan | — |
| Java Dependency Viewer | ✅ 已有 test plan | — |
| Java Extension Pack | ✅ 已有 test plan | webview 内部交互有限 |

---

## 项目结构

```
autotest/
├── src/
│   ├── drivers/
│   │   └── vscodeDriver.ts    # Playwright VSCode 操作原语 (70+ 方法)
│   ├── operators/
│   │   ├── actionResolver.ts   # Action → Driver 调用 (50+ regex)
│   │   ├── stepVerifier.ts     # 确定性验证 (10+ 种策略)
│   │   ├── llmClient.ts        # Azure OpenAI 客户端 (失败截图分析)
│   │   ├── planParser.ts       # YAML Test Plan 解析器（路径相对于 plan 文件）
│   │   └── testRunner.ts       # 编排引擎（启动 → 执行 → 截图 → 报告）
│   ├── cli/
│   │   └── index.ts            # CLI 入口 (run / run-all / analyze / validate)
│   ├── types.ts                # 核心类型定义
│   └── index.ts                # SDK 导出
├── test-plans/                  # YAML 测试计划
├── test-results/                # 测试输出（每个 plan 一个子目录）
│   └── <plan-name>/
│       ├── results.json
│       └── screenshots/
├── AGENTS.md                    # Copilot CLI 集成指南
├── docs/
│   ├── architecture.md          # 架构文档
│   ├── implementation-plan.md   # 实现计划
│   └── ROADMAP.md               # 路线图
└── package.json
```

## 相关文档

- [架构设计](docs/architecture.md)
- [实现计划](docs/implementation-plan.md)
- [路线图](docs/ROADMAP.md)
