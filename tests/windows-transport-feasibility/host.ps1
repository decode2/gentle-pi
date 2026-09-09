# Windows PowerShell 5.1 feasibility host. It receives one bounded JSON configuration
# line from stdin and emits JSONL only; no configuration is interpolated into source.
$ErrorActionPreference = "Stop"
$ConsoleUtf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $ConsoleUtf8
[Console]::InputEncoding = $ConsoleUtf8
[Console]::OutputEncoding = $ConsoleUtf8
$Utf8 = [Text.UTF8Encoding]::new($false, $true)
$MaxLineBytes = 16384

function Emit([string] $stage, [string] $status, $details) {
    [Console]::Out.WriteLine(([ordered]@{ stage = $stage; status = $status; details = $details } | ConvertTo-Json -Compress -Depth 6))
}

Emit "host-startup" "observed" @{ protocol = "ascii-jsonl-v1"; powershellVersion = $PSVersionTable.PSVersion.ToString() }

function DescribeAllowSids($rules, [string] $currentSidValue) {
    $values = @()
    foreach ($rule in $rules) {
        try {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            $values += if ($sid -eq $currentSidValue) { "current-account" } else { "other-sid-present" }
        } catch { $values += "unresolved-identity" }
    }
    return @($values | Sort-Object -Unique)
}

function New-CurrentUserSecurity([Security.Principal.SecurityIdentifier] $sid) {
    $security = [System.IO.Pipes.PipeSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($sid, [System.IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    return $security
}

function New-MetadataSecurity([Security.Principal.SecurityIdentifier] $sid) {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    return $security
}

function Add-NativeProbeType {
    if ("WindowsTransportNativeProbe" -as [type]) { return $true }
    $source = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WindowsTransportNativeProbe {
  [StructLayout(LayoutKind.Sequential)] public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks;
    public uint FileIndexHigh; public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
  [StructLayout(LayoutKind.Sequential)] public struct TOKEN_ELEVATION { public int TokenIsElevated; }
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool GetTokenInformation(IntPtr token, int type, out TOKEN_ELEVATION elevation, int length, out int required);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
    try { Add-Type -TypeDefinition $source -ErrorAction Stop; return $true }
    catch { return $false }
}

function Get-TokenElevation {
    # TokenElevation (20) reads the current process token; it does not alter
    # elevation, create users, invoke RunAs, or modify any policy.
    $process = [Diagnostics.Process]::GetCurrentProcess()
    $token = [IntPtr]::Zero
    try {
        if (-not [WindowsTransportNativeProbe]::OpenProcessToken($process.Handle, 0x0008, [ref]$token)) { throw "OpenProcessToken failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
        $elevation = New-Object WindowsTransportNativeProbe+TOKEN_ELEVATION
        $required = 0
        if (-not [WindowsTransportNativeProbe]::GetTokenInformation($token, 20, [ref]$elevation, 4, [ref]$required)) { throw "GetTokenInformation(TokenElevation) failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
        return ($elevation.TokenIsElevated -ne 0)
    } finally {
        if ($token -ne [IntPtr]::Zero) { [WindowsTransportNativeProbe]::CloseHandle($token) | Out-Null }
        $process.Dispose()
    }
}

function Get-HandleInspection([string] $path) {
    # This opens the final object with FILE_FLAG_OPEN_REPARSE_POINT. It deliberately
    # does not treat a pathname lstat/Get-Item precheck as race-safe validation.
    $handle = [WindowsTransportNativeProbe]::CreateFile($path, 0x80, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
    if ($handle.IsInvalid) { throw "CreateFile failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    try {
        $info = New-Object WindowsTransportNativeProbe+BY_HANDLE_FILE_INFORMATION
        if (-not [WindowsTransportNativeProbe]::GetFileInformationByHandle($handle, [ref]$info)) {
            throw "GetFileInformationByHandle failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        return [ordered]@{
            reparsePoint = (($info.FileAttributes -band 0x400) -ne 0)
            identity = "$($info.VolumeSerialNumber):$($info.FileIndexHigh):$($info.FileIndexLow)"
            validation = "handle-opened-final-object"
        }
    } finally { $handle.Dispose() }
}

function New-SecurePipe([string] $name, [System.IO.Pipes.PipeSecurity] $security) {
    return [System.IO.Pipes.NamedPipeServerStream]::new(
        $name,
        [System.IO.Pipes.PipeDirection]::InOut,
        2,
        [System.IO.Pipes.PipeTransmissionMode]::Byte,
        [System.IO.Pipes.PipeOptions]::Asynchronous,
        4096,
        4096,
        $security
    )
}

$configLine = [Console]::In.ReadLine()
if ($null -eq $configLine -or [Text.Encoding]::UTF8.GetByteCount($configLine) -gt $MaxLineBytes) {
    Emit "input" "blocked" @{ reason = "missing_or_oversized_configuration" }; exit 0
}
try { $config = $configLine | ConvertFrom-Json -ErrorAction Stop }
catch { Emit "input" "blocked" @{ reason = "invalid_configuration_json" }; exit 0 }
if ($null -eq $config -or $config.pipeName -notmatch '^[A-Za-z0-9_-]{12,96}$' -or $config.tempRoot -notmatch '^[A-Za-z]:\\' -or -not ($config.deadlineMs -is [int] -or $config.deadlineMs -is [long]) -or $config.deadlineMs -lt 1000 -or $config.deadlineMs -gt 6500 -or $config.PSObject.Properties.Name -notcontains "allowElevatedDiagnostic" -or $config.allowElevatedDiagnostic -isnot [bool]) {
    Emit "input" "blocked" @{ reason = "configuration_outside_allowlist" }; exit 0
}

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$policy = @{}
try { Get-ExecutionPolicy -List | ForEach-Object { $policy[$_.Scope.ToString()] = $_.ExecutionPolicy.ToString() } }
catch { $policy["error"] = "unavailable" }
$pipeOptions = [Enum]::GetNames([System.IO.Pipes.PipeOptions])
Emit "environment" "observed" @{ powershellVersion = $PSVersionTable.PSVersion.ToString(); dotNetVersion = [Environment]::Version.ToString(); languageMode = [string]$ExecutionContext.SessionState.LanguageMode; executionPolicy = $policy; currentUserOnlyAvailable = ($pipeOptions -contains "CurrentUserOnly"); account = "current account" }

Emit "native-probe-initialization" "starting" @{ operation = "Add-NativeProbeType" }
$nativeReady = Add-NativeProbeType
if (-not $nativeReady) {
    Emit "native-probe-initialization" "unsupported" @{ operation = "Add-NativeProbeType"; dependency = "static Add-Type C# PInvoke; requires FullLanguage and an available compiler" }
    Emit "token-elevation" "blocked" @{ reason = "TokenElevation PInvoke unavailable"; dependency = "static Add-Type C# PInvoke; requires FullLanguage and an available compiler" }
    exit 0
}
Emit "native-probe-initialization" "observed" @{ operation = "Add-NativeProbeType" }
try {
    $isElevated = Get-TokenElevation
    if ($isElevated -and -not $config.allowElevatedDiagnostic) {
        Emit "token-elevation" "blocked" @{ elevated = $true; source = "OpenProcessToken + GetTokenInformation(TokenElevation)"; action = "read-only token inspection" }
        Emit "experiment" "blocked" @{ reason = "elevated token is outside this feasibility experiment without the explicit diagnostic exception; no downgrade, RunAs, user, or policy workaround attempted" }; exit 0
    }
    Emit "token-elevation" "observed" @{ elevated = $isElevated; source = "OpenProcessToken + GetTokenInformation(TokenElevation)"; action = "read-only token inspection" }
    if ($isElevated) { Emit "elevated-diagnostic-exception" "observed" @{ runtimeElevated = $true; unprivilegedValidation = $false; productSupport = $false; scope = "elevated diagnostic capabilities only" } }
} catch {
    Emit "token-elevation" "blocked" @{ reason = "token elevation could not be verified"; error = $_.Exception.GetType().Name }
    exit 0
}

$pipeSecurity = $null
try {
    $pipeSecurity = New-CurrentUserSecurity $currentSid
    $capabilityPipe = New-SecurePipe ("capability_" + $config.pipeName) $pipeSecurity
    $capabilityPipe.Dispose()
    Emit "pipe-security-overload" "supported" @{ explicitPipeSecurity = $true; options = "Asynchronous"; aclBaseline = "current-account SID only"; trustPolicy = "unverified experimental compatibility baseline, not product authorization" }
} catch {
    Emit "pipe-security-overload" "unsupported" @{ explicitPipeSecurity = $false; error = $_.Exception.GetType().Name; message = $_.Exception.Message.Substring(0, [Math]::Min(240, $_.Exception.Message.Length)) }
    exit 0
}

$metadata = Join-Path $config.tempRoot ("metadata-" + [Guid]::NewGuid().ToString("N"))
try {
    $metadataSecurity = New-MetadataSecurity $currentSid
    [IO.Directory]::CreateDirectory($metadata, $metadataSecurity) | Out-Null
    $metadataAcl = Get-Acl -LiteralPath $metadata
    $rules = $metadataAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    Emit "metadata-directory" "observed" @{ protectedDacl = $metadataAcl.AreAccessRulesProtected; allowSids = @(DescribeAllowSids ($rules | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow }) $currentSid.Value); inheritedRules = @($rules | Where-Object { $_.IsInherited }).Count; creation = "Directory.CreateDirectory(path, DirectorySecurity)" }
} catch {
    Emit "metadata-directory" "unsupported" @{ error = $_.Exception.GetType().Name; message = $_.Exception.Message.Substring(0, [Math]::Min(240, $_.Exception.Message.Length)) }
    exit 0
}

Emit "native-capability" "supported" @{ operation = "handle_open_reparse_and_identity"; dependency = "static Add-Type C# PInvoke; requires FullLanguage and an available compiler"; languageMode = [string]$ExecutionContext.SessionState.LanguageMode }
if ($nativeReady) {
    try {
        $publication = Join-Path $metadata "presence.json"
        $first = [IO.File]::Open($publication, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $bytes = $Utf8.GetBytes('{"version":1}'); $first.Write($bytes, 0, $bytes.Length) } finally { $first.Dispose() }
        $noReplace = $false
        try { $second = [IO.File]::Open($publication, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $second.Dispose() } catch [IO.IOException] { $noReplace = $true }
        $identity = Get-HandleInspection $publication
        $target = Join-Path $metadata "junction-target"; $junction = Join-Path $metadata "junction"
        [IO.Directory]::CreateDirectory($target) | Out-Null
        $junctionResult = "unsupported"
        try {
            New-Item -ItemType Junction -Path $junction -Target $target -ErrorAction Stop | Out-Null
            $junctionInfo = Get-HandleInspection $junction
            $junctionResult = if ($junctionInfo.reparsePoint) { "rejected_by_handle_attribute" } else { "unexpected_non_reparse" }
        } catch { $junctionResult = "unsupported:$($_.Exception.GetType().Name)" }
        Emit "metadata-publication" "observed" @{ noReplaceCreateNew = $noReplace; fileIdentityObserved = ($identity.identity.Length -gt 0); fileIdentityStability = "unverified: one handle observation is not a stability proof"; reparseValidation = $identity.validation; junctionProbe = $junctionResult; requiredMetadataCapability = ($noReplace -and $identity.identity.Length -gt 0); secondUserDenialTest = "unverified: DACL inspection is not an actual second-user denial test" }
    } catch {
        Emit "metadata-publication" "unsupported" @{ error = $_.Exception.GetType().Name; message = $_.Exception.Message.Substring(0, [Math]::Min(240, $_.Exception.Message.Length)) }
    }
}

Emit "security-limitations" "partial" @{ pipeDaclReadback = "unverified: construction with PipeSecurity is not ACL readback"; reparseScope = "final object only; no ancestor traversal or TOCTOU proof"; secondUserDenial = "unverified: no second-user test was performed" }

$servers = @()
try {
    foreach ($i in 1..2) {
        $pipe = New-SecurePipe $config.pipeName $pipeSecurity
        $servers += [pscustomobject]@{ Pipe = $pipe; Wait = $pipe.BeginWaitForConnection($null, $null); Read = $null; Data = [Collections.Generic.List[byte]]::new(); Complete = $false }
    }
    Emit "pipe-host" "ready" @{ pipeName = $config.pipeName; instances = 2; ownerPid = $PID; protocol = "bounded-jsonl" }
    $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$config.deadlineMs)
    $accepted = 0; $replies = 0
    while ([DateTime]::UtcNow -lt $deadline -and $replies -lt 1) {
        foreach ($server in $servers) {
            if ($server.Complete) { continue }
            if ($null -ne $server.Wait -and $server.Wait.IsCompleted) {
                $server.Pipe.EndWaitForConnection($server.Wait); $server.Wait = $null; $accepted++
                $buffer = New-Object byte[] 4096
                $server.Read = [pscustomobject]@{ Buffer = $buffer; Async = $server.Pipe.BeginRead($buffer, 0, $buffer.Length, $null, $null) }
            }
            if ($null -ne $server.Read -and $server.Read.Async.IsCompleted) {
                $count = $server.Pipe.EndRead($server.Read.Async)
                if ($count -le 0) { $server.Complete = $true; continue }
                for ($index = 0; $index -lt $count; $index++) { $server.Data.Add($server.Read.Buffer[$index]) }
                if ($server.Data.Count -gt 8192) { $server.Complete = $true; continue }
                $newline = $server.Data.IndexOf([byte]10)
                if ($newline -ge 0) {
                    $request = $null
                    try { $request = $Utf8.GetString($server.Data.ToArray(), 0, $newline) | ConvertFrom-Json -ErrorAction Stop } catch {}
                    if ($null -ne $request -and $request.id -is [string] -and $request.id -match '^[A-Za-z0-9_-]{1,64}$' -and $request.op -eq "ping") {
                        $reply = $Utf8.GetBytes(([ordered]@{ ok = $true; id = $request.id; hostPid = $PID } | ConvertTo-Json -Compress) + "`n")
                        $server.Pipe.Write($reply, 0, $reply.Length); $server.Pipe.Flush(); $replies++
                    }
                    $server.Complete = $true
                } else {
                    $buffer = New-Object byte[] 4096
                    $server.Read = [pscustomobject]@{ Buffer = $buffer; Async = $server.Pipe.BeginRead($buffer, 0, $buffer.Length, $null, $null) }
                }
            }
        }
        Start-Sleep -Milliseconds 10
    }
    Emit "pipe-host" ($(if ($replies -eq 1) { "observed" } else { "unsupported" })) @{ pipeName = $config.pipeName; acceptedConnections = $accepted; replies = $replies; concurrentAcceptEvidence = ($accepted -ge 2 -and $replies -eq 1); cleanup = "disposing host-owned handles" }
} catch {
    Emit "pipe-host" "unsupported" @{ error = $_.Exception.GetType().Name; message = $_.Exception.Message.Substring(0, [Math]::Min(240, $_.Exception.Message.Length)) }
} finally {
    foreach ($server in $servers) { try { $server.Pipe.Dispose() } catch {} }
}
