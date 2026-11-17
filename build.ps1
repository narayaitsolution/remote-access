# Builds build\bin\RemoteTerminal.exe. The file name has no version, so an
# update is just replacing the file; the version (from version.go) is shown in
# the app's Information window and window title.
# Does not clean build\bin, so config.toml and known_hosts there are kept.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$m = Select-String -Path version.go -Pattern 'const appVersion = "([^"]+)"'
if (-not $m) { throw 'appVersion not found in version.go' }
$version = $m.Matches[0].Groups[1].Value
$out = "RemoteTerminal.exe"
Write-Host "Building $out (version $version)"
wails build -trimpath -ldflags "-s -w" -o $out
if ($LASTEXITCODE -ne 0) { throw "wails build failed ($LASTEXITCODE)" }
Write-Host "Done: build\bin\$out (version $version)"
