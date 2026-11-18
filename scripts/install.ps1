#Requires -Version 5.1
<#
.SYNOPSIS
  Install qq-cli-bridge from a source checkout on Windows.

.DESCRIPTION
  Checks the Node.js version, installs locked dependencies (npm ci), builds the
  TypeScript sources, and prints how to put the `qqbridge` shim on PATH.
  Does not touch the data/ directory, credentials, or any AI CLI login.

.PARAMETER AddToUserPath
  Also append the repository's bin\ directory to the *user* PATH (persistent).
#>
param(
  [switch]$AddToUserPath
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$MinNode = [Version]"22.13.0"

function Fail([string]$msg) {
  Write-Host "ERROR: $msg" -ForegroundColor Red
  exit 1
}

# --- Node.js version check --------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js not found. Install Node.js $MinNode or newer (22 LTS or 24 LTS) from https://nodejs.org/" }
$nodeVersion = [Version]((& node --version).TrimStart("v"))
if ($nodeVersion -lt $MinNode) {
  Fail "Node.js $nodeVersion is too old. qq-cli-bridge needs >= $MinNode (built-in node:sqlite)."
}
Write-Host "Node.js $nodeVersion OK"

Push-Location $Root
try {
  Write-Host "Installing locked dependencies (npm ci) in $Root ..."
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed" }

  Write-Host "Building..."
  npm run build
  if ($LASTEXITCODE -ne 0) { Fail "npm run build failed" }

  $shimDir = Join-Path $Root "bin"

  if ($AddToUserPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ";") -notcontains $shimDir) {
      [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $shimDir), "User")
      Write-Host "Added $shimDir to your user PATH (open a new terminal to use it)."
    } else {
      Write-Host "$shimDir is already on your user PATH."
    }
  }

  Write-Host ""
  Write-Host "Installed." -ForegroundColor Green
  if (-not $AddToUserPath) {
    Write-Host "Add qqbridge to PATH for this session:"
    Write-Host "  `$env:Path = `"$shimDir;`" + `$env:Path"
  }
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  1. Install and log in to Claude Code (claude) and/or Codex CLI (codex)."
  Write-Host "  2. qqbridge setup        # scan the QR code with mobile QQ"
  Write-Host "  3. qqbridge claude --transport stream --no-terminal"
} finally {
  Pop-Location
}
