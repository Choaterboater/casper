# Runs on a disposable Windows CI runner, after scripts/test-install-windows.ps1: install.ps1's release
# signature check, with throwaway keys made here for this run. No real release key is pinned or used.
# Each install runs in its own PowerShell (this one's kind) with a temp home, so no sign-in is read.
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Release = Join-Path $Root 'dist\release'
$Expected = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
$Shell = (Get-Process -Id $PID).Path
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('casper-sig-test-' + [guid]::NewGuid().ToString('N'))
$EnvKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$HadUserPath = $EnvKey.GetValueNames() -contains 'Path'
$OldUserPath = if ($HadUserPath) { $EnvKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
$OldUserPathKind = if ($HadUserPath) { $EnvKey.GetValueKind('Path') } else { $null }
$EnvKey.Close()
$Server = $null

$Keygen = Get-Command ssh-keygen -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Keygen) { throw 'This test needs ssh-keygen (OpenSSH), which Windows runners have.' }

# Start-Process passes the empty passphrase as "" under both PowerShell 5.1 and 7 (5.1 drops a plain '' argument).
function Invoke-Keygen([string]$Arguments) {
  $Run = Start-Process -FilePath $Keygen.Source -ArgumentList $Arguments -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $Temp 'keygen-out.txt') -RedirectStandardError (Join-Path $Temp 'keygen-err.txt')
  if ($Run.ExitCode -ne 0) { throw "ssh-keygen $Arguments failed: $(Get-Content -Raw (Join-Path $Temp 'keygen-err.txt'))" }
}
function New-TestKey([string]$Path) {
  Invoke-Keygen ('-q -t ed25519 -N "" -C casper-test -f "{0}"' -f $Path)
  ((Get-Content -Raw "$Path.pub").Trim() -split '\s+')[0..1] -join ' '
}
function Set-Signature([string]$Key, [string]$Content) {
  $Sums = Join-Path $Temp 'to-sign'
  [IO.File]::WriteAllText($Sums, $Content)
  Remove-Item "$Sums.sig" -ErrorAction SilentlyContinue
  Invoke-Keygen ('-Y sign -f "{0}" -n casper-release "{1}"' -f $Key, $Sums)
  Copy-Item -Force "$Sums.sig" (Join-Path $Served 'SHA256SUMS.sig')
}

# One install in a new PowerShell. Returns its exit code and everything it printed.
function Invoke-Install([string]$Script, [hashtable]$Env, [string]$UseShell = $Shell) {
  $Lines = @(
    "`$env:CASPER_INSTALL_DIR = '$InstallDir'",
    "`$env:TEMP = '$InstallerTemp'; `$env:TMP = '$InstallerTemp'",
    "`$env:HOME = '$HomeDir'; `$env:USERPROFILE = '$HomeDir'; `$env:APPDATA = '$HomeDir\Roaming'; `$env:LOCALAPPDATA = '$HomeDir\Local'; `$env:GH_CONFIG_DIR = '$HomeDir\gh'",
    "foreach (`$Name in 'GH_TOKEN', 'GITHUB_TOKEN', 'CASPER_BASE_URL', 'CASPER_VERSION', 'CASPER_SHA256', 'CASPER_ARCH') { Remove-Item `"Env:`$Name`" -ErrorAction SilentlyContinue }"
  )
  foreach ($Name in $Env.Keys) { $Lines += "`$env:$Name = '$($Env[$Name])'" }
  $Lines += "try { Invoke-RestMethod '$Url/$Script' | Invoke-Expression; exit 0 } catch { Write-Host ('REFUSED: ' + `$_.Exception.Message); exit 1 }"
  $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($Lines -join "`n")))
  $Saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $Out = (& $UseShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $Encoded 2>&1) | Out-String } finally { $ErrorActionPreference = $Saved }
  @{ Code = $LASTEXITCODE; Out = $Out }
}

# A refused install leaves the old casper.exe byte for byte, and no staged file or download folder behind.
function Assert-Refused([string]$Case, $Result, [string]$Words) {
  if ($Result.Code -eq 0) { throw "$Case was installed:`n$($Result.Out)" }
  if ($Result.Out -notmatch [regex]::Escape($Words)) { throw "$Case was refused without saying '$Words':`n$($Result.Out)" }
  if ([IO.File]::ReadAllText((Join-Path $InstallDir 'casper.exe')) -ne 'previous casper') { throw "$Case replaced the old casper.exe" }
  $Left = @(Get-ChildItem -Force $InstallDir | Where-Object { $_.Name -ne 'casper.exe' }) + @(Get-ChildItem -Force $InstallerTemp -Filter 'casper-install-*')
  if ($Left.Count) { throw "$Case left files behind: $($Left.Name -join ', ')" }
  Write-Host "ok: $Case is refused and nothing changed"
}
function Assert-Installed([string]$Case, $Result, [string]$Words) {
  if ($Result.Code -ne 0) { throw "$Case was not installed:`n$($Result.Out)" }
  if ($Result.Out -notmatch [regex]::Escape($Words)) { throw "$Case did not say '$Words':`n$($Result.Out)" }
  $Version = & (Join-Path $InstallDir 'casper.exe') --version
  if (($Version -join ' ') -notmatch ('^casper ' + [regex]::Escape($Expected) + ' ')) { throw "$Case installed something else: $Version" }
  $Left = @(Get-ChildItem -Force $InstallerTemp -Filter 'casper-install-*')
  if ($Left.Count) { throw "$Case left files behind: $($Left.Name -join ', ')" }
  Write-Host "ok: $Case is installed"
}
function Reset-Install { [IO.File]::WriteAllText((Join-Path $InstallDir 'casper.exe'), 'previous casper') }

try {
  $Served = Join-Path $Temp 'release'
  $InstallDir = Join-Path $Temp 'install space'
  $InstallerTemp = Join-Path $Temp 'installer temp'
  $HomeDir = Join-Path $Temp 'home'
  New-Item -ItemType Directory -Path $Served, $InstallDir, $InstallerTemp, $HomeDir | Out-Null
  Copy-Item (Join-Path $Release 'SHA256SUMS') $Served
  Copy-Item (Join-Path $Release 'casper-windows-*.exe') $Served
  $Sums = [IO.File]::ReadAllText((Join-Path $Served 'SHA256SUMS'))

  $Key = Join-Path $Temp 'release key'
  $OtherKey = Join-Path $Temp 'other key'
  $PublicKey = New-TestKey $Key
  $null = New-TestKey $OtherKey

  $Listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $Listener.Start(); $Port = $Listener.LocalEndpoint.Port; $Listener.Stop()
  $Url = "http://127.0.0.1:$Port"
  # Pinned the way scripts/release-key.ts pins a key. install-own.ps1 also takes this server as the release's own address.
  $Installer = [IO.File]::ReadAllText((Join-Path $Root 'scripts\install.ps1'))
  $Keyed = [regex]::Replace($Installer, "(?m)^\`$ReleaseKey = '[^']*'$", "`$ReleaseKey = '$PublicKey'")
  if ($Keyed -notmatch [regex]::Escape($PublicKey)) { throw 'No release key line in install.ps1' }
  $Own = [regex]::Replace($Keyed, "else \{ 'https://github\.com/Choaterboater/casper/releases/download/[^']*' \}", "else { '$Url' }")
  if ($Own -notmatch [regex]::Escape("else { '$Url' }")) { throw "No release address line in install.ps1" }
  [IO.File]::WriteAllText((Join-Path $Served 'install-keyed.ps1'), $Keyed)
  [IO.File]::WriteAllText((Join-Path $Served 'install-own.ps1'), $Own)

  $Server = Start-Process python -ArgumentList @('-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', "`"$Served`"") -PassThru -WindowStyle Hidden
  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    try { $null = Invoke-WebRequest "$Url/SHA256SUMS" -UseBasicParsing; $Ready = $true; break } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $Ready) { throw 'Local release server did not start' }
  $Local = @{ CASPER_BASE_URL = $Url }

  Set-Signature $Key $Sums
  Reset-Install
  Assert-Installed 'a list signed with the pinned key' (Invoke-Install 'install-keyed.ps1' $Local) 'Verified: signed with the Casper release key.'
  Reset-Install
  Assert-Installed 'a signed list from the release address' (Invoke-Install 'install-own.ps1' @{}) 'Verified: signed with the Casper release key.'

  $Refused = "The release signature doesn't match the Casper release key. Nothing installed."
  Set-Signature $OtherKey $Sums
  Reset-Install
  Assert-Refused 'a list signed by another key' (Invoke-Install 'install-keyed.ps1' $Local) $Refused
  Reset-Install
  Assert-Refused 'a list signed by another key, from the release address' (Invoke-Install 'install-own.ps1' @{}) $Refused

  Set-Signature $Key $Sums
  [IO.File]::WriteAllText((Join-Path $Served 'SHA256SUMS'), $Sums + ('0' * 64) + "  casper-extra`n")
  Assert-Refused 'a list changed after it was signed' (Invoke-Install 'install-keyed.ps1' $Local) $Refused
  [IO.File]::WriteAllText((Join-Path $Served 'SHA256SUMS'), $Sums)
  [IO.File]::WriteAllText((Join-Path $Served 'SHA256SUMS.sig'), "not a signature`n")
  Assert-Refused 'a signature file that is not one' (Invoke-Install 'install-keyed.ps1' $Local) $Refused

  Remove-Item (Join-Path $Served 'SHA256SUMS.sig')
  Assert-Refused 'no signature from the release address' (Invoke-Install 'install-own.ps1' @{}) 'This release has no signature (SHA256SUMS.sig), so it may not be a Casper release. Nothing installed.'
  Assert-Installed 'no signature from another address' (Invoke-Install 'install-keyed.ps1' $Local) "No signature (SHA256SUMS.sig) at $Url; checking SHA-256 only."

  # Too old is asked of ssh-keygen alone: an old one is named and the SHA-256 decides; one that knows -Y but fails
  # the real check with an old one's words is still a refusal.
  $Fakes = Join-Path $Temp 'fake ssh'
  New-Item -ItemType Directory -Path (Join-Path $Fakes 'old'), (Join-Path $Fakes 'new') | Out-Null
  [IO.File]::WriteAllText((Join-Path $Fakes 'old\ssh-keygen.cmd'), "@echo off`r`necho ssh-keygen: unknown option -- Y 1>&2`r`necho usage: ssh-keygen [-q] 1>&2`r`nexit /b 1`r`n")
  [IO.File]::WriteAllText((Join-Path $Fakes 'new\ssh-keygen.cmd'), "@echo off`r`nfor %%a in (%*) do if `"%%~a`"==`"-s`" (echo illegal option 1>&2& exit /b 255)`r`necho Too few arguments for verify: missing namespace 1>&2`r`nexit /b 1`r`n")
  Set-Signature $Key $Sums
  Reset-Install
  Assert-Installed 'an ssh-keygen too old to check' (Invoke-Install 'install-keyed.ps1' ($Local + @{ Path = "$Fakes\old;$env:Path" })) 'This ssh-keygen is too old to check the release signature (OpenSSH 8.1 or newer can).'
  Reset-Install
  Assert-Refused 'a failed check with an old one''s words' (Invoke-Install 'install-keyed.ps1' ($Local + @{ Path = "$Fakes\new;$env:Path" })) $Refused

  # Where it was built is asked of a signed-in gh whose own version is 2.56.0 or newer. An older one (it has the
  # command from 2.47, but cannot check Casper's attestations before 2.56) or one with an unreadable version is named
  # and the SHA-256 decides. A new enough one whose check fails is a refusal, never taken for an old one.
  $FakeGh = Join-Path $Temp 'fake gh'
  function New-FakeGh([string]$Name, [string]$VersionLine) {
    New-Item -ItemType Directory -Path (Join-Path $FakeGh $Name) | Out-Null
    $Body = "@echo off`r`nif `"%~1`"==`"auth`" exit /b 0`r`nif `"%~1`"==`"--version`" goto version`r`necho Error: verifying with issuer `"sigstore.dev`" 1>&2`r`nexit /b 1`r`n:version`r`necho $VersionLine`r`nexit /b 0`r`n"
    [IO.File]::WriteAllText((Join-Path $FakeGh "$Name\gh.cmd"), $Body)
  }
  New-Item -ItemType Directory -Path $FakeGh | Out-Null
  New-FakeGh 'old' 'gh version 2.55.0 2024-08-01'
  New-FakeGh 'junk' 'something unexpected'
  New-FakeGh 'new' 'gh version 2.56.0 2024-08-13'
  Set-Signature $Key $Sums
  Reset-Install
  Assert-Installed 'a signed-in gh older than 2.56' (Invoke-Install 'install-keyed.ps1' ($Local + @{ Path = "$FakeGh\old;$env:Path" })) 'Checked SHA-256. This gh is too old to check where it was built (gh 2.56 or newer can).'
  Reset-Install
  Assert-Installed 'a signed-in gh whose version cannot be read' (Invoke-Install 'install-keyed.ps1' ($Local + @{ Path = "$FakeGh\junk;$env:Path" })) 'Checked SHA-256. This gh is too old to check where it was built (gh 2.56 or newer can).'
  Reset-Install
  Assert-Refused 'a gh whose build check fails' (Invoke-Install 'install-keyed.ps1' ($Local + @{ Path = "$FakeGh\new;$env:Path" })) "This download doesn't match a Casper build from GitHub. Nothing installed."

  # A 32-bit Windows PowerShell on 64-bit Windows is shown SysWOW64 for System32, where OpenSSH is not. It must still
  # find Windows' own ssh-keygen, so a 32-bit shell gets the same check. Only System32's OpenSSH stays on its PATH.
  $Shell32 = Join-Path $env:windir 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
  $Native = Join-Path $env:windir 'System32\OpenSSH\ssh-keygen.exe'
  if ([Environment]::Is64BitProcess -and (Test-Path $Shell32) -and (Test-Path $Native)) {
    $Path32 = ($env:Path -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq (Split-Path $Native) -or -not (Test-Path (Join-Path $_ 'ssh-keygen.exe'))) }) -join ';'
    Set-Signature $OtherKey $Sums
    Reset-Install
    Assert-Refused 'a list signed by another key, in a 32-bit PowerShell' (Invoke-Install 'install-keyed.ps1' ($Local + @{ Path = $Path32 }) $Shell32) $Refused
    Set-Signature $Key $Sums
    Reset-Install
    Assert-Installed 'a signed list, in a 32-bit PowerShell' (Invoke-Install 'install-keyed.ps1' ($Local + @{ Path = $Path32 }) $Shell32) 'Verified: signed with the Casper release key.'
  } else {
    Write-Host "skip: 32-bit PowerShell case (64-bit process: $([Environment]::Is64BitProcess), $Shell32 there: $(Test-Path $Shell32), $Native there: $(Test-Path $Native))"
  }
  Write-Host 'PASS: install.ps1 installs a list signed with the pinned key; refuses another key, a changed list, a broken signature and a missing one from the release address; says so for a missing one elsewhere, an old ssh-keygen and an old gh; refuses a failed gh build check; a 32-bit PowerShell checks too'
} finally {
  if ($Server -and -not $Server.HasExited) { Stop-Process -Id $Server.Id -ErrorAction SilentlyContinue }
  # The installs above add their folder to the user PATH; put it back as it was, type and all.
  $EnvKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    if ($HadUserPath) { $EnvKey.SetValue('Path', $OldUserPath, $OldUserPathKind) } elseif ($EnvKey.GetValueNames() -contains 'Path') { $EnvKey.DeleteValue('Path') }
  } finally { $EnvKey.Close() }
  Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
