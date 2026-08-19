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
  & tar.exe -xf $package -C $extractRoot
  if ($LASTEXITCODE -ne 0) { throw "Failed to extract package: $package" }
  & node (Join-Path $PSScriptRoot "smoke-test-plugin.mjs") $extractRoot
  if ($LASTEXITCODE -ne 0) { throw "Package smoke test failed: $package" }
}
finally {
  if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
}
