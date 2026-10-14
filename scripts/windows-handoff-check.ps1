# Run on the Windows PC, without changing or installing Casper:
# powershell -ExecutionPolicy Bypass -File windows-handoff-check.ps1
# Uses only its own temp folder and one temporary scheduled task (removed at the end).
# No downloads, admin rights, install changes or persistent settings.
# PowerShell Start-Process is a comparison; Bun/Node, when on PATH, test detached spawn too.
# This does not simulate every job/console condition of a compiled casper.exe.
$ErrorActionPreference = 'Stop'
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('casper-handoff-check-' + [guid]::NewGuid().ToString('N'))
$TaskName = 'casper-handoff-check-' + [guid]::NewGuid().ToString('N')
$Shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Methods = @('hidden', 'wmi', 'scheduled-task')
$Parents = @()
function Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Encoded([string]$Code) { return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code)) }
try {
  New-Item -ItemType Directory -Path $Temp | Out-Null
  $Helper = Join-Path $Temp 'helper.ps1'
  @'
param([string]$Log)
Start-Sleep -Seconds 10
Set-Content -LiteralPath $Log -Value ('alive ' + (Get-Date).ToString('o')) -Encoding UTF8
'@ | Set-Content -LiteralPath $Helper -Encoding UTF8
  $Js = Join-Path $Temp 'parent.cjs'
  @'
const { spawn } = require('node:child_process');
const child = spawn(process.argv[2], ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', process.argv[3], '-Log', process.argv[4]], { detached: true, windowsHide: true, stdio: 'ignore' });
child.once('error', () => { process.exitCode = 1; });
child.once('spawn', () => child.unref());
'@ | Set-Content -LiteralPath $Js -Encoding UTF8
  $Runtimes = @{}
  foreach ($Name in @('bun', 'node')) {
    $Runtime = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Runtime) { $Methods += $Name; $Runtimes[$Name] = $Runtime.Source }
  }
  foreach ($Method in $Methods) {
    $Log = Join-Path $Temp ($Method + '.log')
    # File names generated here cannot contain quotes. No cmd.exe: &, % and spaces stay literal.
    $CommandLine = '"' + $Shell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Helper + '" -Log "' + $Log + '"'
    $Common = "`$ErrorActionPreference = 'Stop'; `$Shell = $(Literal $Shell); `$CommandLine = $(Literal $CommandLine); `$Temp = $(Literal $Temp); `$TaskName = $(Literal $TaskName); "
    $Launch = switch ($Method) {
      'hidden' { 'Start-Process -FilePath $Shell -ArgumentList $CommandLine.Substring(($Shell.Length + 3)) -WindowStyle Hidden | Out-Null' }
      'wmi' { '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $CommandLine; CurrentDirectory = $Temp }; if ($r.ReturnValue -ne 0 -or -not $r.ProcessId) { throw "WMI refused: $($r.ReturnValue)" }' }
      'scheduled-task' {
        @'
$Action = New-ScheduledTaskAction -Execute $Shell -Argument $CommandLine.Substring(($Shell.Length + 3)) -WorkingDirectory $Temp
$Principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Principal $Principal -Trigger $Trigger | Out-Null
Start-ScheduledTask -TaskName $TaskName
'@
      }
      default {
        # The short-lived runtime, not this PowerShell, is the helper's parent.
        $NativeArgs = @($Js, $Shell, $Helper, $Log) | ForEach-Object { Literal $_ }
        '& ' + (Literal $Runtimes[$Method]) + ' ' + ($NativeArgs -join ' ') + '; if ($LASTEXITCODE -ne 0) { throw "runtime spawn failed" }'
      }
    }
    $ErrorFile = Join-Path $Temp ($Method + '.error')
    $Code = $Common + 'try { ' + $Launch + ' } catch { Set-Content -LiteralPath ' + (Literal $ErrorFile) + ' -Value $_.Exception.Message; exit 1 }; exit 0'
    $Parent = Start-Process -FilePath $Shell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', (Encoded $Code)) -PassThru -WindowStyle Hidden
    $Parents += $Parent
    # A live parent would make the survival result meaningless.
    if (-not $Parent.WaitForExit(20000)) { throw "The $Method parent did not exit; no survival result is valid" }
  }
  Start-Sleep -Seconds 15
  foreach ($Method in $Methods) {
    $Log = Join-Path $Temp ($Method + '.log')
    $Alive = (Test-Path -LiteralPath $Log) -and ((Get-Content -LiteralPath $Log -Raw) -match '^alive ')
    $Result = if ($Alive) { 'survived' } else { 'killed' }
    Write-Output ($Method + ': ' + $Result)
    $ErrorFile = Join-Path $Temp ($Method + '.error')
    if (Test-Path -LiteralPath $ErrorFile) { Write-Warning ($Method + ' launch failed: ' + (Get-Content -LiteralPath $ErrorFile -Raw).Trim()) }
  }
} finally {
  # Only the unique task and directory created by this probe are removed.
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  foreach ($Parent in $Parents) { $Parent.Dispose() }
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
