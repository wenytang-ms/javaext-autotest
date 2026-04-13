# javaext-autotest — Copilot CLI 使用指南

本项目是 AI 驱动的 VSCode 扩展 E2E 测试框架。Copilot CLI 可以直接使用它来运行测试。

## 快速命令

### 运行测试

```bash
cd javaext-autotest

# 运行单个 test plan
npx autotest run test-plans/java-maven.yaml

# 运行全部 test plan
npm run run:all
```

### 验证 test plan 格式

```bash
npx autotest validate test-plans/<plan>.yaml
```

### 可用的 Test Plan

| 文件 | 场景 | 状态 |
|------|------|------|
| `test-plans/java-maven.yaml` | Maven 项目：LS → 补全 → 导航 → 编辑 → 诊断 | ✅ 8/8 |
| `test-plans/java-maven-multimodule.yaml` | Maven 多模块：两模块补全 | ✅ 5/5 |
| `test-plans/java-gradle.yaml` | Gradle 项目：LS → 补全 → 编辑 | ✅ 7/7 |
| `test-plans/java-basic-editing.yaml` | Basic #1-5：代码片段 → Code Action → 编译 | 🔲 待验证 |
| `test-plans/java-basic-extended.yaml` | Basic #6-8：补全 → Import → Rename | ✅ 8/8 |
| `test-plans/java-single-file.yaml` | 单文件编辑：LS → 补全 → 编辑 | ✅ 6/6 |

### CLI 选项

| 选项 | 说明 |
|------|------|
| `--output <dir>` | 输出目录（默认 `./test-results/<plan-name>/`） |
| `--no-llm` | 跳过 LLM 验证（auto-pass verify 字段） |

### 测试输出结构

每个 test plan 输出到 `test-results/<plan-name>/`：
```
test-results/java-maven/
├── results.json          # 测试报告
└── screenshots/          # 每步 before + after 截图
    ├── ls-ready_before.png
    ├── ls-ready_after.png
    └── ...
```

## 运行后分析

1. **查看 `results.json`** — 检查 `summary` 和每个 step 的 `status`/`reason`
2. **查看截图** — 每步都有 `{stepId}_before.png` + `{stepId}_after.png`
3. **失败排查** — 读截图文件（PNG）判断 UI 状态，结合 `reason` 字段定位问题

## 运行前清理（如果遇到旧窗口问题）

```powershell
Remove-Item "$env:TEMP\autotest-*" -Recurse -Force -ErrorAction SilentlyContinue
```

## 环境要求

- Node.js ≥ 18，已 `npm install`
- JDK 已安装
- `vscode-java` 和 `eclipse.jdt.ls` 仓库已 clone 到同级目录

## LLM 验证（可选）

配置环境变量启用 Azure OpenAI 截图验证：

```
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

未配置时 `verify` 字段自动跳过，不影响确定性验证。
