# VSCode AutoTest

AI 驱动的 VSCode 扩展 E2E 测试框架。

用户提供 YAML 格式的 Test Plan → 框架自动启动 VSCode → 执行操作 → 验证结果。

> **目标**：让 Copilot CLI 直接读取 wiki 中的 Test Plan，自动完成 VSCode 扩展的端到端测试。

---

## 快速开始

```bash
# 安装依赖
npm install

# 编译
npm run build

# 验证 test plan 格式
npx autotest validate test-plans/java-basic-editing.yaml

# 执行测试
npx autotest run test-plans/java-basic-editing.yaml

# 输出 JSON 报告
npx autotest run test-plans/java-maven.yaml --output results.json
```

### 前置条件

- Node.js ≥ 18
- JDK 已安装（测试 Java 扩展时需要）
- vscode-java 仓库已 clone 到本地（test plan 中引用了其测试项目）

---

## 核心架构

```
┌─────────────────────────────────────────────────────┐
│             Test Plan (YAML / Markdown)              │
│  描述测试步骤 + 预期结果，不包含硬编码 locator        │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│                AI Test Runner                        │
│  解析 Plan → 映射 Action → 执行 → Snapshot → 验证   │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│           VscodeDriver (操作原语 SDK)                 │
│  基于 Playwright Electron + @vscode/test-electron    │
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
  extension: "my-extension"
  extensionPath: "./path/to/extension"
  vscodeVersion: "stable"
  workspace: "./test-workspace"
  timeout: 60

steps:
  - id: "step-1"
    action: "执行命令 My Extension: Hello"
    verifyNotification: "Hello World!"
```

### 支持的 Action（自然语言 → Driver 映射）

| Action 写法 | 映射操作 | 示例 |
|-------------|---------|------|
| `执行命令 XXX` / `run command XXX` | Command Palette 执行 | `执行命令 Java: Force Java Compilation` |
| `打开文件 XXX` / `open file XXX` | Quick Open 打开文件 | `打开文件 src/app/Foo.java` |
| `点击侧边栏 XXX tab` | 切换侧边栏 Tab | `点击侧边栏 Explorer tab` |
| `展开/点击 XXX 节点` | TreeView 操作 | `展开 APIs 节点` |
| `选择 XXX 选项` | Palette 选项选择 | `选择 GitHub 选项` |
| `等待 N 秒` / `wait N seconds` | 等待指定时间 | `等待 5 秒` |
| `waitForLanguageServer` | 等待 LS 就绪 | `waitForLanguageServer` |
| `typeInEditor XXX` | 在编辑器输入文本 | `typeInEditor System.out.println()` |
| `typeAndTriggerSnippet XXX` | 输入并触发代码片段 | `typeAndTriggerSnippet class` |
| `navigateToError N` | 跳转到第 N 个错误 | `navigateToError 1` |
| `applyCodeAction XXX` | 执行 Code Action | `applyCodeAction Import 'ArrayList'` |
| `triggerCompletion` | 触发代码补全 | `triggerCompletion` |

### 支持的验证方式

| 字段 | 类型 | 说明 |
|------|------|------|
| `verify` | string | 自然语言描述预期结果（AI 验证，Phase 4） |
| `verifyFile` | object | 文件存在性 / 内容匹配 |
| `verifyNotification` | string | 通知消息匹配 |
| `verifyEditor` | object | 编辑器内容 / 语言 / 文件名 |
| `verifyProblems` | object | Problems 面板错误/警告计数 |
| `verifyCompletion` | object | 代码补全列表验证 |

---

## 现有 Test Plan

| 文件 | 来源 | 场景 |
|------|------|------|
| `java-basic-editing.yaml` | wiki Basic #1-5 | LS 就绪 → 代码片段 → Code Action → 编译 |
| `java-maven.yaml` | wiki Maven | Maven 项目导入 → 编辑验证 → 补全 → Code Action |
| `api-center-tree-view.yaml` | 示例 | Azure API Center 树视图导航 |
| `register-api-cicd.yaml` | 示例 | CI/CD 注册 API 流程 |

---

## 项目结构

```
autotest/
├── src/
│   ├── drivers/
│   │   └── vscodeDriver.ts    # Playwright VSCode 操作原语 (30+ 方法)
│   ├── operators/
│   │   ├── planParser.ts       # YAML Test Plan 解析器
│   │   └── testRunner.ts       # 测试执行引擎 (13 种 action 模式)
│   ├── cli/
│   │   └── index.ts            # CLI 入口 (run / validate)
│   ├── types.ts                # 核心类型定义
│   └── index.ts                # SDK 导出
├── test-plans/                  # YAML 测试计划
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
