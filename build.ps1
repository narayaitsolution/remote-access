# Builds build\bin\RemoteTerminal-<version>.exe, with the version taken from version.go.
# Does not clean build\bin, so config.toml and known_hosts there are kept.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$m = Select-String -Path version.go -Pattern 'const appVersion = "([^"]+)"'
if (-not $m) { throw 'appVersion not found in version.go' }
$version = $m.Matches[0].Groups[1].Value
$out = "RemoteTerminal-$version.exe"
Write-Host "Building $out"
wails build -trimpath -ldflags "-s -w" -o $out
if ($LASTEXITCODE -ne 0) { throw "wails build failed ($LASTEXITCODE)" }
Write-Host "Done: build\bin\$out"
