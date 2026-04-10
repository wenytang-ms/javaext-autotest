# javaext-autotest — Copilot CLI 使用指南

本项目是 AI 驱动的 VSCode 扩展 E2E 测试框架。Copilot CLI 可以直接使用它来运行测试。

## 快速命令

### 运行测试

```bash
cd javaext-autotest
npx autotest run test-plans/<plan>.yaml --output results.json
```

### 验证 test plan 格式

```bash
npx autotest validate test-plans/<plan>.yaml
```

### 可用的 Test Plan

| 文件 | 场景 |
|------|------|
| `test-plans/java-maven.yaml` | Maven 项目：LS 就绪 → 打开文件 → 补全 → 导航 → 编辑 → 诊断 |
| `test-plans/java-basic-editing.yaml` | Basic 编辑：LS 就绪 → 代码片段 → Code Action → 编译 |

### CLI 选项

| 选项 | 说明 |
|------|------|
| `--output <path>` | JSON 报告输出路径 |
| `--screenshots <dir>` | 截图目录（默认 `./screenshots`） |
| `--no-llm` | 跳过 LLM 验证（auto-pass verify 字段） |

## 运行后分析

1. **查看 `results.json`** — 检查 `summary` 和每个 step 的 `status`/`reason`
2. **查看截图** — 失败步骤有 `{stepId}_before.png` + `{stepId}_after.png`，通过步骤只有 `_after.png`
3. **失败排查** — 读截图文件（PNG）判断 UI 状态，结合 `reason` 字段定位问题

## 运行前清理（如果遇到旧窗口问题）

```powershell
Remove-Item "$env:TEMP\autotest-*" -Recurse -Force -ErrorAction SilentlyContinue
```

## 环境要求

- Node.js ≥ 18，已 `npm install`
- JDK 已安装
- `vscode-java` 仓库已 clone 到 `../vscode-java`

## LLM 验证（可选）

配置环境变量启用 Azure OpenAI 截图验证：

```
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

未配置时 `verify` 字段自动跳过，不影响确定性验证。
