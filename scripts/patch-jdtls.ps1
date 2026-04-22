<#
.SYNOPSIS
  Build jdt.ls core module and patch the jar into vscode-java's server directory.

.DESCRIPTION
  Incremental build helper for the autotest fix loop:
  1. Builds only org.eclipse.jdt.ls.core (+ target) using Maven (~30s with cache)
  2. Copies the built jar over the existing one in vscode-java/server/plugins/

.PARAMETER JdtlsDir
  Path to eclipse.jdt.ls repo (default: ../eclipse.jdt.ls relative to this script)

.PARAMETER VscodeJavaDir
  Path to vscode-java repo (default: ../vscode-java relative to this script)

.EXAMPLE
  # From javaext-autotest root:
  .\scripts\patch-jdtls.ps1

  # Custom paths:
  .\scripts\patch-jdtls.ps1 -JdtlsDir C:\repos\eclipse.jdt.ls -VscodeJavaDir C:\repos\vscode-java
#>

param(
    [string]$JdtlsDir,
    [string]$VscodeJavaDir
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

if (-not $JdtlsDir) { $JdtlsDir = Join-Path (Split-Path -Parent $RepoRoot) "eclipse.jdt.ls" }
if (-not $VscodeJavaDir) { $VscodeJavaDir = Join-Path (Split-Path -Parent $RepoRoot) "vscode-java" }

# Validate paths
if (-not (Test-Path "$JdtlsDir\mvnw.cmd")) {
    Write-Error "eclipse.jdt.ls not found at: $JdtlsDir (missing mvnw.cmd)"
    exit 1
}
$ServerPlugins = Join-Path $VscodeJavaDir "server\plugins"
if (-not (Test-Path $ServerPlugins)) {
    Write-Error "vscode-java server not built yet: $ServerPlugins not found. Run 'npx gulp build_server' in vscode-java first."
    exit 1
}

# Step 1: Build jdt.ls core
Write-Host "`n🔨 Building jdt.ls core..." -ForegroundColor Cyan
Push-Location $JdtlsDir
try {
    $buildOutput = cmd /c "mvnw.cmd -pl org.eclipse.jdt.ls.core,org.eclipse.jdt.ls.target clean package -DskipTests -Declipse.jdt.ls.skipGradleChecksums 2>&1"
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host $buildOutput -ForegroundColor Red
        Write-Error "Maven build failed (exit code: $exitCode)"
        exit 1
    }
    Write-Host "   ✅ Build succeeded" -ForegroundColor Green
} finally {
    Pop-Location
}

# Step 2: Find and copy jar
$builtJar = Get-ChildItem "$JdtlsDir\org.eclipse.jdt.ls.core\target\org.eclipse.jdt.ls.core-*-SNAPSHOT.jar" |
    Where-Object { $_.Name -notmatch "sources" } |
    Select-Object -First 1

if (-not $builtJar) {
    Write-Error "Built jar not found in $JdtlsDir\org.eclipse.jdt.ls.core\target\"
    exit 1
}

$targetJar = Get-ChildItem "$ServerPlugins\org.eclipse.jdt.ls.core_*.jar" | Select-Object -First 1
if (-not $targetJar) {
    Write-Error "Target jar not found in $ServerPlugins"
    exit 1
}

Copy-Item $builtJar.FullName $targetJar.FullName -Force
Write-Host "`n📦 Patched:" -ForegroundColor Cyan
Write-Host "   Source: $($builtJar.Name)"
Write-Host "   Target: $($targetJar.FullName)"
Write-Host "`n✅ Done! Run your test plan with extensionPath pointing to vscode-java." -ForegroundColor Green
