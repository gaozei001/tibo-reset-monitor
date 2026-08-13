param(
  [switch]$Demo
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDir

if ($Demo) {
  node .\src\demo.mjs
  exit $LASTEXITCODE
}

if (-not $env:X_BEARER_TOKEN) {
  Write-Warning "X_BEARER_TOKEN 尚未设置。面板仍会启动，但不会连接 X。"
  Write-Host "当前 PowerShell 会话中可这样设置：`$env:X_BEARER_TOKEN = '你的 Bearer Token'"
}

node .\src\main.mjs
