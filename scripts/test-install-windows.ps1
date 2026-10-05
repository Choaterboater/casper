# Runs on a disposable Windows CI runner; never touches an existing Casper install.
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Release = Join-Path $Root 'dist\release'
# The version under test is whatever this checkout builds; never hardcode it here.
$Expected = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
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
  $env:CASPER_VERSION = $Expected
  Invoke-RestMethod "$env:CASPER_BASE_URL/install.ps1" | Invoke-Expression
  $Binary = Join-Path $env:CASPER_INSTALL_DIR 'casper.exe'
  $Version = & $Binary --version
  if ($LASTEXITCODE -ne 0 -or ($Version -join ' ') -notmatch ('^casper ' + [regex]::Escape($Expected) + ' ')) { throw 'Installed binary version failed' }
  # The installed file is built for this PC, also when this PowerShell runs under emulation.
  $PcArch = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
  $Stream = [IO.File]::OpenRead($Binary)
  try { $Head = New-Object byte[] 4096; $null = $Stream.Read($Head, 0, $Head.Length) } finally { $Stream.Close() }
  $Machine = [BitConverter]::ToUInt16($Head, [BitConverter]::ToInt32($Head, 0x3C) + 4)
  $Want = @{ 'AMD64' = 0x8664; 'ARM64' = 0xAA64 }[$PcArch]
  if ($Machine -ne $Want) { throw ('casper.exe is built for machine 0x{0:X4}, but this PC is {1} (shell sees {2})' -f $Machine, $PcArch, $env:PROCESSOR_ARCHITECTURE) }
  Write-Host ('Installed casper.exe matches this PC: {0} (shell sees {1})' -f $PcArch, $env:PROCESSOR_ARCHITECTURE)
  if ((Get-Command casper).Source -ne $Binary) { throw 'Current-session PATH was not updated' }
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($UserPath -split ';') -notcontains $env:CASPER_INSTALL_DIR) { throw 'Persistent PATH missing install directory' }
  # A stock account's user PATH is REG_EXPAND_SZ with %USERPROFILE% in it. Installing keeps both.
  $Stock = '%USERPROFILE%\AppData\Local\Microsoft\WindowsApps'
  $EnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try { $EnvKey.SetValue('Path', $Stock, [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $EnvKey.Close() }
  Invoke-RestMethod "$env:CASPER_BASE_URL/install.ps1" | Invoke-Expression
  $EnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  try {
    $Kind = $EnvKey.GetValueKind('Path')
    $Raw = [string]$EnvKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally { $EnvKey.Close() }
  if ($Kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw "User PATH changed type to $Kind" }
  if (($Raw -split ';') -notcontains $Stock) { throw "User PATH lost $Stock (written out in full instead)" }
  if (($Raw -split ';') -notcontains $env:CASPER_INSTALL_DIR) { throw 'Persistent PATH missing install directory after a stock PATH' }
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
    $env:CASPER_VERSION = if ($Failure -eq 'version') { '9.9.9' } else { $Expected }
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
