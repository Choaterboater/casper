# Runs on a disposable Windows CI runner; never touches an existing Casper install.
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Release = Join-Path $Root 'dist\release'
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('casper-install-test-' + [guid]::NewGuid().ToString('N'))
$OldUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$OldPath = $env:Path
$Server = $null
try {
  New-Item -ItemType Directory -Path $Temp | Out-Null
  $Listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $Listener.Start(); $Port = $Listener.LocalEndpoint.Port; $Listener.Stop()
  $Server = Start-Process python -ArgumentList @('-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', "`"$Release`"") -PassThru -WindowStyle Hidden
  $env:CASPER_BASE_URL = "http://127.0.0.1:$Port"
  $env:CASPER_INSTALL_DIR = Join-Path $Temp 'install space'
  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    try { $null = Invoke-WebRequest "$env:CASPER_BASE_URL/VERSION" -UseBasicParsing; $Ready = $true; break } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $Ready) { throw 'Local release server did not start' }
  # Fresh account case: no existing per-user PATH.
  [Environment]::SetEnvironmentVariable('Path', $null, 'User')
  $env:CASPER_VERSION = '0.1.0'
  Invoke-RestMethod "$env:CASPER_BASE_URL/install.ps1" | Invoke-Expression
  $Binary = Join-Path $env:CASPER_INSTALL_DIR 'casper.exe'
  $Version = & $Binary --version
  if ($LASTEXITCODE -ne 0 -or $Version -ne 'casper 0.1.0') { throw 'Installed binary version failed' }
  if ((Get-Command casper).Source -ne $Binary) { throw 'Current-session PATH was not updated' }
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($UserPath -split ';') -notcontains $env:CASPER_INSTALL_DIR) { throw 'Persistent PATH missing install directory' }
  $null = & $Binary --help
  if ($LASTEXITCODE -ne 0) { throw 'Help failed' }
  $Licenses = & $Binary --licenses
  if ($LASTEXITCODE -ne 0 -or ($Licenses -join "`n") -notmatch 'THIRD.PARTY') { throw 'Embedded license notices unavailable' }
  $Project = Join-Path $Temp 'project'; New-Item -ItemType Directory -Path $Project | Out-Null
  Set-Content (Join-Path $Project 'index.ts') 'export const answer = 42;'
  Push-Location $Project
  try {
    $null = & $Binary /project
    if ($LASTEXITCODE -ne 0) { throw 'Project inspection failed' }
    $Diagram = & $Binary '/visualize repo'
    if ($LASTEXITCODE -ne 0 -or ($Diagram -join "`n") -notmatch 'flowchart LR') { throw 'Inline visualization failed' }
  } finally { Pop-Location }
  $Before = (Get-FileHash $Binary).Hash
  foreach ($Failure in @('version', 'checksum')) {
    $env:CASPER_VERSION = if ($Failure -eq 'version') { '9.9.9' } else { '0.1.0' }
    $env:CASPER_SHA256 = if ($Failure -eq 'checksum') { '0' * 64 } else { $null }
    $Rejected = $false
    try { Invoke-RestMethod "$env:CASPER_BASE_URL/install.ps1" | Invoke-Expression } catch { $Rejected = $true }
    if (-not $Rejected) { throw "Installer accepted incorrect $Failure" }
    if ((Get-FileHash $Binary).Hash -ne $Before) { throw "Rejected $Failure replaced the existing binary" }
    if (Test-Path (Join-Path $env:CASPER_INSTALL_DIR '.casper-download.exe')) { throw 'Staged download leaked' }
  }
  Write-Host 'PASS: served Windows install, persistent/current PATH, version/help/licenses/project/diagram, rejected checksum and version preserve existing binary'
} finally {
  if ($Server -and -not $Server.HasExited) { Stop-Process -Id $Server.Id -ErrorAction SilentlyContinue }
  [Environment]::SetEnvironmentVariable('Path', $OldUserPath, 'User')
  $env:Path = $OldPath
  foreach ($Name in @('CASPER_BASE_URL', 'CASPER_INSTALL_DIR', 'CASPER_VERSION', 'CASPER_SHA256')) { Remove-Item "Env:$Name" -ErrorAction SilentlyContinue }
  Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
