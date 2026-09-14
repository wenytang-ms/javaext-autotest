const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const OUTPUT_ENV = "AUTOTEST_PROBE_OUTPUT";
const DUMP_COMMAND = "autotest.dumpEvidence";
let writeTimer;

function diagnosticSeverity(value) {
  switch (value) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}

function diagnosticCode(code) {
  if (code === undefined) return undefined;
  if (typeof code === "string" || typeof code === "number") return code;
  return {
    value: code.value,
    target: code.target?.toString(),
  };
}

function createSnapshot() {
  const diagnostics = [];
  for (const [uri, entries] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of entries) {
      diagnostics.push({
        uri: uri.toString(),
        file: uri.scheme === "file" ? uri.fsPath : undefined,
        severity: diagnosticSeverity(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnosticCode(diagnostic.code),
        range: {
          start: {
            line: diagnostic.range.start.line + 1,
            character: diagnostic.range.start.character + 1,
          },
          end: {
            line: diagnostic.range.end.line + 1,
            character: diagnostic.range.end.character + 1,
          },
        },
      });
    }
  }

  const extensions = vscode.extensions.all
    .filter((extension) => !extension.packageJSON?.isBuiltin && !extension.id.startsWith("vscode."))
    .map((extension) => ({
      id: extension.id,
      version: extension.packageJSON?.version,
      isActive: extension.isActive,
      extensionKind: extension.extensionKind,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    vscode: {
      version: vscode.version,
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      remoteName: vscode.env.remoteName,
      uiKind: vscode.env.uiKind,
    },
    process: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      execPath: process.execPath,
    },
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()),
    activeEditor: vscode.window.activeTextEditor
      ? {
          uri: vscode.window.activeTextEditor.document.uri.toString(),
          file: vscode.window.activeTextEditor.document.uri.scheme === "file"
            ? vscode.window.activeTextEditor.document.uri.fsPath
            : undefined,
          languageId: vscode.window.activeTextEditor.document.languageId,
        }
      : undefined,
    diagnostics,
    extensions,
  };
}

async function writeSnapshot(outputPath = process.env[OUTPUT_ENV]) {
  if (!outputPath) return;

  const snapshot = createSnapshot();
  const directory = path.dirname(outputPath);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.promises.rm(outputPath, { force: true });
  await fs.promises.rename(temporaryPath, outputPath);
}

function scheduleSnapshot(delay = 250) {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeSnapshot().catch(() => {
      // Evidence collection is best-effort and must not affect the extension under test.
    });
  }, delay);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(DUMP_COMMAND, async (outputPath) => {
      await writeSnapshot(typeof outputPath === "string" ? outputPath : undefined);
    }),
    vscode.languages.onDidChangeDiagnostics(() => scheduleSnapshot()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleSnapshot()),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleSnapshot()),
    vscode.extensions.onDidChange(() => scheduleSnapshot()),
  );

  scheduleSnapshot(0);
}

async function deactivate() {
  clearTimeout(writeTimer);
  await writeSnapshot().catch(() => {});
}

module.exports = { activate, deactivate };
