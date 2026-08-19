[CmdletBinding()]
param(
  [string]$OutputDirectory = "dist"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root ".codex-plugin\plugin.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$staging = Join-Path ([IO.Path]::GetTempPath()) ("autopw-package-" + [guid]::NewGuid().ToString("N"))
$outputRoot = Join-Path $root $OutputDirectory
$archivePath = Join-Path $outputRoot ("autopw-win-x64-" + $version + ".zip")

try {
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

  Push-Location $root
  npm ci --omit=dev
  $env:PLAYWRIGHT_BROWSERS_PATH = "0"
  node (Join-Path $root "node_modules\playwright-core\cli.js") install chromium
  Pop-Location

  $include = @(
    ".codex-plugin", ".claude-plugin", ".codebuddy-plugin", ".workbuddy-plugin",
    "skills", ".mcp.json", "package.json", "package-lock.json", "README.md", "LICENSE", "node_modules"
  )
  foreach ($item in $include) {
    Copy-Item -LiteralPath (Join-Path $root $item) -Destination (Join-Path $staging $item) -Recurse -Force
  }

  $browserRoot = Join-Path $staging "node_modules\playwright-core\.local-browsers"
  if (-not (Test-Path -LiteralPath $browserRoot)) {
    throw "Bundled Chromium directory was not created: $browserRoot"
  }
  $chromiumExecutable = Get-ChildItem -LiteralPath $browserRoot -Recurse -File -Filter "chrome.exe" | Select-Object -First 1
  if (-not $chromiumExecutable) {
    throw "Bundled Chromium executable chrome.exe was not found under $browserRoot"
  }

  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  $archiveEntries = Get-ChildItem -LiteralPath $staging -Force | Select-Object -ExpandProperty FullName
  Compress-Archive -Path $archiveEntries -DestinationPath $archivePath -CompressionLevel Optimal
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\smoke-test-package.ps1") -PackagePath $archivePath
  if ($LASTEXITCODE -ne 0) { throw "Package smoke test failed: $archivePath" }
  Write-Output "Created $archivePath"
  Write-Output "Bundled Chromium: $($chromiumExecutable.FullName)"
}
finally {
  if ((Get-Location).Path -eq $root) { Pop-Location -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
