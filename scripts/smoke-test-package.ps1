[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath
)

$ErrorActionPreference = "Stop"
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$extractRoot = Join-Path ([IO.Path]::GetTempPath()) ("autopw-smoke-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($package, $extractRoot)
  & node (Join-Path $PSScriptRoot "smoke-test-plugin.mjs") $extractRoot
  if ($LASTEXITCODE -ne 0) { throw "Package smoke test failed: $package" }
}
finally {
  if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
}
