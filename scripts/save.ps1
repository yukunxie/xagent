# save.ps1 — 编译验证后自动提交 git
# 用法: .\scripts\save.ps1 [可选提交信息]

param(
    [string]$Message = ""
)

Set-Location $PSScriptRoot\..

Write-Host "🔨 验证 Rust 编译..." -ForegroundColor Cyan
cargo build --manifest-path src-tauri/Cargo.toml 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 编译失败，取消提交" -ForegroundColor Red
    exit 1
}

$changed = git status --porcelain
if (-not $changed) {
    Write-Host "✅ 没有变更需要提交" -ForegroundColor Yellow
    exit 0
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$commitMsg = if ($Message) { $Message } else { "chore: auto-save $timestamp" }

git add -A
git commit -m $commitMsg

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ 已提交: $commitMsg" -ForegroundColor Green
    git log --oneline -3
} else {
    Write-Host "❌ 提交失败" -ForegroundColor Red
}
