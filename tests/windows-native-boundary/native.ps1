# Bounded capability fixture, not a production transport implementation.
# NtCreateFile RootDirectory and user-mode ntdll export:
# https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile
# OBJECT_ATTRIBUTES, UNICODE_STRING, IO_STATUS_BLOCK ABI:
# https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes
# https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_unicode_string
# https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ns-wdm-_io_status_block
# Numeric NtCreateFile constants are from Microsoft's win32metadata winternl.h:
# https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/um/winternl.h
# FILE_RENAME_INFO / FILE_DISPOSITION_INFO layout is from Microsoft's winbase.h:
# https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/um/WinBase.h
# Collision values ERROR_FILE_EXISTS=80 / ERROR_ALREADY_EXISTS=183 are from:
# https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/shared/winerror.h
# Handle-based rename/delete API and FileRenameInfo=3/FileDispositionInfo=4:
# https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
# https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info
# Scope: a newly created private disposable root. This neither proves arbitrary
# profile/volume bootstrap trust nor cross-user denial. It emits no SID or path.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$schema = 'gentle-pi.windows-native-boundary/v1'
$stage = 'abi'
$root = $null
$junction = $null
$completed = $false
$cleanupFailed = $false

function Get-Architecture {
	if ([IntPtr]::Size -eq 4) { return 'x86' }
	if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
	return 'x64'
}
function Write-Result([bool]$ok, [string]$failedStage, [string]$architecture, [bool]$elevated) {
	if ($ok) {
		[Console]::Out.WriteLine((@{ schema = $schema; ok = $true; architecture = $architecture; elevated = $elevated; stages = @('abi', 'anchored-open', 'dacl', 'identity', 'replace-delete', 'reparse-negative'); scope = 'private-disposable-root' } | ConvertTo-Json -Compress))
		return
	}
	[Console]::Out.WriteLine((@{ schema = $schema; ok = $false; stage = $failedStage; architecture = $architecture; elevated = $elevated } | ConvertTo-Json -Compress))
}

$architecture = Get-Architecture
$elevated = $false
try {
	Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NativeBoundary {
  [StructLayout(LayoutKind.Sequential)] public struct UNICODE_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] public struct OBJECT_ATTRIBUTES { public uint Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
  public struct NativeOpenResult {
    public IntPtr Handle;
    public uint Status;
    public NativeOpenResult(IntPtr handle, uint status) { Handle = handle; Status = status; }
  }
  [StructLayout(LayoutKind.Sequential)] public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }
  const uint OBJ_CASE_INSENSITIVE = 0x40, OBJ_DONT_REPARSE = 0x1000;
  const uint SYNCHRONIZE = 0x00100000, FILE_READ_DATA = 1, FILE_WRITE_DATA = 2, FILE_READ_ATTRIBUTES = 0x80, READ_CONTROL = 0x00020000, DELETE = 0x00010000;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint FILE_CREATE = 2, FILE_OPEN = 1, FILE_DIRECTORY_FILE = 1, FILE_NON_DIRECTORY_FILE = 0x40, FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint SE_FILE_OBJECT = 1, DACL_SECURITY_INFORMATION = 4;
  // STATUS_OBJECT_NAME_NOT_FOUND is from Microsoft win32metadata ntstatus.h:
  // https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/shared/ntstatus.h
  const uint STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034;
  const int FileRenameInfo = 3, FileDispositionInfo = 4;
  [DllImport("ntdll.dll", CallingConvention=CallingConvention.Winapi)] static extern uint NtCreateFile(out IntPtr fileHandle, uint desiredAccess, ref OBJECT_ATTRIBUTES objectAttributes, out IO_STATUS_BLOCK ioStatusBlock, IntPtr allocationSize, uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer, uint eaLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr handle, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int type, out int elevation, int size, out int returned);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(IntPtr handle, uint objectType, uint securityInformation, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static int PointerSize() { return IntPtr.Size; }
  public static int ObjectAttributesSize() { return Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)); }
  public static int UnicodeStringSize() { return Marshal.SizeOf(typeof(UNICODE_STRING)); }
  public static int IoStatusBlockSize() { return Marshal.SizeOf(typeof(IO_STATUS_BLOCK)); }
  public static int Offset(string field) { return (int)Marshal.OffsetOf(typeof(OBJECT_ATTRIBUTES), field); }
  public static bool TokenElevated() {
    IntPtr token = IntPtr.Zero; try { if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error()); int value, returned; if (!GetTokenInformation(token, 20, out value, 4, out returned) || returned != 4) throw new Win32Exception(Marshal.GetLastWin32Error()); return value != 0; } finally { if (token != IntPtr.Zero) CloseHandle(token); }
  }
  static IntPtr Unicode(string value, out IntPtr chars) { chars = Marshal.StringToHGlobalUni(value); UNICODE_STRING text = new UNICODE_STRING(); text.Length = checked((ushort)(value.Length * 2)); text.MaximumLength = text.Length; text.Buffer = chars; IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING))); Marshal.StructureToPtr(text, pointer, false); return pointer; }
  static IntPtr Descriptor(byte[] bytes) { if (bytes == null || bytes.Length == 0) throw new ArgumentException("owned creation requires a descriptor"); IntPtr value = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, value, bytes.Length); return value; }
  static NativeOpenResult OpenWithStatus(IntPtr root, string name, bool directory, bool create, byte[] descriptor) {
    IntPtr chars = IntPtr.Zero, unicode = IntPtr.Zero, security = IntPtr.Zero, handle = IntPtr.Zero;
    try {
      unicode = Unicode(name, out chars); OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES();
      attributes.Length = (uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)); attributes.RootDirectory = root;
      attributes.ObjectName = unicode; attributes.Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;
      if (create) security = attributes.SecurityDescriptor = Descriptor(descriptor);
      IO_STATUS_BLOCK statusBlock;
      uint status = NtCreateFile(out handle, SYNCHRONIZE | FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | DELETE, ref attributes, out statusBlock, IntPtr.Zero, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, create ? FILE_CREATE : FILE_OPEN, (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE) | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, IntPtr.Zero, 0);
      if (status != 0 && handle != IntPtr.Zero) CloseHandle(handle);
      return new NativeOpenResult(status == 0 ? handle : IntPtr.Zero, status);
    } finally { if (security != IntPtr.Zero) Marshal.FreeHGlobal(security); if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); if (chars != IntPtr.Zero) Marshal.FreeHGlobal(chars); }
  }
  static IntPtr Open(IntPtr root, string name, bool directory, bool create, byte[] descriptor) { return OpenWithStatus(root, name, directory, create, descriptor).Handle; }
  public static IntPtr OpenRoot(string path) { return Open(IntPtr.Zero, "\\??\\" + path, true, false, null); }
  public static IntPtr CreateRelative(IntPtr root, string component, bool directory, byte[] descriptor) { return Open(root, component, directory, true, descriptor); }
  public static IntPtr OpenRelative(IntPtr root, string component, bool directory) { return Open(root, component, directory, false, null); }
  public static NativeOpenResult OpenRelativeWithStatus(IntPtr root, string component, bool directory) { return OpenWithStatus(root, component, directory, false, null); }
  public static uint StatusObjectNameNotFound() { return STATUS_OBJECT_NAME_NOT_FOUND; }
  public static bool Close(IntPtr handle) { return handle != IntPtr.Zero && CloseHandle(handle); }
  public static string Identity(IntPtr handle) { BY_HANDLE_FILE_INFORMATION info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error()); return info.VolumeSerialNumber.ToString("X8") + ":" + info.FileIndexHigh.ToString("X8") + info.FileIndexLow.ToString("X8"); }
  public static byte[] ReadDacl(IntPtr handle) { IntPtr owner, group, dacl, sacl, descriptor = IntPtr.Zero; uint status = GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor); if (status != 0 || descriptor == IntPtr.Zero) throw new Win32Exception((int)status); try { uint length = GetSecurityDescriptorLength(descriptor); if (length == 0 || length > 65536) throw new InvalidOperationException(); byte[] bytes = new byte[length]; Marshal.Copy(descriptor, bytes, 0, (int)length); return bytes; } finally { LocalFree(descriptor); } }
  static int SetInfo(IntPtr handle, int infoClass, IntPtr memory, uint length) { return SetFileInformationByHandle(handle, infoClass, memory, length) ? 0 : Marshal.GetLastWin32Error(); }
  public static int RenameNoReplace(IntPtr file, IntPtr root, string name) { byte[] chars = System.Text.Encoding.Unicode.GetBytes(name); int header = IntPtr.Size == 8 ? 20 : 12; IntPtr memory = Marshal.AllocHGlobal(header + chars.Length); try { for (int i = 0; i < header + chars.Length; i++) Marshal.WriteByte(memory, i, 0); Marshal.WriteIntPtr(memory, IntPtr.Size == 8 ? 8 : 4, root); Marshal.WriteInt32(memory, IntPtr.Size == 8 ? 16 : 8, chars.Length); Marshal.Copy(chars, 0, IntPtr.Add(memory, header), chars.Length); return SetInfo(file, FileRenameInfo, memory, (uint)(header + chars.Length)); } finally { Marshal.FreeHGlobal(memory); } }
  public static int MarkDelete(IntPtr file) { IntPtr memory = Marshal.AllocHGlobal(1); try { Marshal.WriteByte(memory, 1); return SetInfo(file, FileDispositionInfo, memory, 1); } finally { Marshal.FreeHGlobal(memory); } }
}
'@
	$elevated = [NativeBoundary]::TokenElevated()
	$pointerSize = [NativeBoundary]::PointerSize()
	$expectedSize = if ($pointerSize -eq 8) { 48 } else { 24 }
	$expectedUnicodeSize = if ($pointerSize -eq 8) { 16 } else { 8 }
	if ([NativeBoundary]::UnicodeStringSize() -ne $expectedUnicodeSize) { throw 'abi' }
	if ([NativeBoundary]::IoStatusBlockSize() -ne ($pointerSize * 2) -or [NativeBoundary]::ObjectAttributesSize() -ne $expectedSize) { throw 'abi' }
	$offsets = @('Length', 'RootDirectory', 'ObjectName', 'Attributes', 'SecurityDescriptor', 'SecurityQualityOfService'); $pointer = [NativeBoundary]::PointerSize(); $expectedOffsets = @(0, $pointer, $pointer * 2, $pointer * 3, $pointer * 4, $pointer * 5)
	for ($index = 0; $index -lt $offsets.Count; $index++) { if ([NativeBoundary]::Offset($offsets[$index]) -ne $expectedOffsets[$index]) { throw 'abi' } }

	$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
	$directorySecurity = [Security.AccessControl.DirectorySecurity]::new(); $directorySecurity.SetAccessRuleProtection($true, $false); $directorySecurity.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
	$root = Join-Path ([IO.Path]::GetTempPath()) ('gentle-native-' + [Guid]::NewGuid().ToString('N'))
	[IO.Directory]::CreateDirectory($root, $directorySecurity) | Out-Null
	$descriptor = $directorySecurity.GetSecurityDescriptorBinaryForm()

	function Read-HandleSecurity([IntPtr]$handle, [bool]$directory) {
		$security = if ($directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
		$security.SetSecurityDescriptorBinaryForm([NativeBoundary]::ReadDacl($handle))
		return $security
	}
	function Assert-CurrentFullControl($security) {
		if (-not $security.AreAccessRulesProtected) { throw 'dacl' }
		$rules = $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
		if ($rules.Count -ne 1) { throw 'dacl' }
		$rule = $rules[0]
		if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -ne $sid.Value -or [int64]$rule.FileSystemRights -ne [int64][Security.AccessControl.FileSystemRights]::FullControl) { throw 'dacl' }
	}
	function Assert-CurrentPipeFullControl($security) {
		if (-not $security.AreAccessRulesProtected) { throw 'dacl' }
		$rules = $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
		if ($rules.Count -ne 1) { throw 'dacl' }
		$rule = $rules[0]
		if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -ne $sid.Value -or [int64]$rule.PipeAccessRights -ne [int64][IO.Pipes.PipeAccessRights]::FullControl) { throw 'dacl' }
	}

	$stage = 'anchored-open'; $rootHandle = [NativeBoundary]::OpenRoot($root); if ($rootHandle -eq [IntPtr]::Zero) { throw 'anchored-open' }
	try {
		$anchor = [NativeBoundary]::CreateRelative($rootHandle, 'anchor', $true, $descriptor); if ($anchor -eq [IntPtr]::Zero) { throw 'anchored-open' }
		try {
			$original = [NativeBoundary]::CreateRelative($anchor, 'record.tmp', $false, $descriptor); if ($original -eq [IntPtr]::Zero) { throw 'anchored-open' }
			try {
				$stage = 'dacl'; Assert-CurrentFullControl (Read-HandleSecurity $rootHandle $true); Assert-CurrentFullControl (Read-HandleSecurity $anchor $true); Assert-CurrentFullControl (Read-HandleSecurity $original $false)
				$pipeSecurity = [IO.Pipes.PipeSecurity]::new(); $pipeSecurity.SetAccessRuleProtection($true, $false); $pipeSecurity.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid, [IO.Pipes.PipeAccessRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)); $pipe = [IO.Pipes.NamedPipeServerStream]::new(('gentle-native-' + [Guid]::NewGuid().ToString('N')), [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 0, 0, $pipeSecurity); try { Assert-CurrentPipeFullControl ($pipe.GetAccessControl()) } finally { $pipe.Dispose() }
				$stage = 'identity'; $originalIdentity = [NativeBoundary]::Identity($original); $sameOriginal = [NativeBoundary]::OpenRelative($anchor, 'record.tmp', $false); if ($sameOriginal -eq [IntPtr]::Zero) { throw 'identity' }; try { if ($originalIdentity -ne [NativeBoundary]::Identity($sameOriginal)) { throw 'identity' } } finally { [NativeBoundary]::Close($sameOriginal) | Out-Null }
				$stage = 'replace-delete'; $destination = [NativeBoundary]::CreateRelative($anchor, 'activation.json', $false, $descriptor); if ($destination -eq [IntPtr]::Zero) { throw 'replace-delete' }; try { $destinationIdentity = [NativeBoundary]::Identity($destination); $collision = [NativeBoundary]::RenameNoReplace($original, $anchor, 'activation.json'); if ($collision -notin @(80, 183)) { throw 'replace-delete' }; $recordCheck = [NativeBoundary]::OpenRelative($anchor, 'record.tmp', $false); $destinationCheck = [NativeBoundary]::OpenRelative($anchor, 'activation.json', $false); try { if ($recordCheck -eq [IntPtr]::Zero -or $destinationCheck -eq [IntPtr]::Zero -or $originalIdentity -ne [NativeBoundary]::Identity($recordCheck) -or $destinationIdentity -ne [NativeBoundary]::Identity($destinationCheck)) { throw 'replace-delete' } } finally { [NativeBoundary]::Close($recordCheck) | Out-Null; [NativeBoundary]::Close($destinationCheck) | Out-Null }
					$tombstone = 'tombstone-' + [Guid]::NewGuid().ToString('N'); if ([NativeBoundary]::RenameNoReplace($original, $anchor, $tombstone) -ne 0) { throw 'replace-delete' }; $replacement = [NativeBoundary]::CreateRelative($anchor, 'record.tmp', $false, $descriptor); if ($replacement -eq [IntPtr]::Zero) { throw 'replace-delete' }; try { $replacementIdentity = [NativeBoundary]::Identity($replacement); if ($replacementIdentity -eq $originalIdentity -or [NativeBoundary]::MarkDelete($original) -ne 0) { throw 'replace-delete' }; $replacementCheck = [NativeBoundary]::OpenRelative($anchor, 'record.tmp', $false); try { if ($replacementCheck -eq [IntPtr]::Zero -or $replacementIdentity -ne [NativeBoundary]::Identity($replacementCheck)) { throw 'replace-delete' } } finally { [NativeBoundary]::Close($replacementCheck) | Out-Null } } finally { [NativeBoundary]::Close($replacement) | Out-Null }
				} finally { [NativeBoundary]::Close($destination) | Out-Null }
				[NativeBoundary]::Close($original) | Out-Null
				$original = [IntPtr]::Zero
				$tombstoneResult = [NativeBoundary]::OpenRelativeWithStatus($anchor, $tombstone, $false)
				if ($tombstoneResult.Handle -ne [IntPtr]::Zero) { [NativeBoundary]::Close($tombstoneResult.Handle) | Out-Null; throw 'replace-delete' }
				if ($tombstoneResult.Status -ne [NativeBoundary]::StatusObjectNameNotFound()) { throw 'replace-delete' }
				$postCloseReplacement = [NativeBoundary]::OpenRelative($anchor, 'record.tmp', $false)
				try {
					if ($postCloseReplacement -eq [IntPtr]::Zero -or $replacementIdentity -ne [NativeBoundary]::Identity($postCloseReplacement)) { throw 'replace-delete' }
				} finally { [NativeBoundary]::Close($postCloseReplacement) | Out-Null }
				$stage = 'reparse-negative'; $junction = Join-Path $root 'junction'; New-Item -ItemType Junction -Path $junction -Target (Join-Path $root 'anchor') | Out-Null; $throughJunction = [NativeBoundary]::OpenRelative($rootHandle, 'junction\record.tmp', $false); if ($throughJunction -ne [IntPtr]::Zero) { [NativeBoundary]::Close($throughJunction) | Out-Null; throw 'reparse-negative' }; [IO.Directory]::Delete($junction, $false); $junction = $null
				$completed = $true
			} finally { [NativeBoundary]::Close($original) | Out-Null }
		} finally { [NativeBoundary]::Close($anchor) | Out-Null }
	} finally { [NativeBoundary]::Close($rootHandle) | Out-Null }
} catch {
	$completed = $false
} finally {
	try { if ($null -ne $junction -and [IO.Directory]::Exists($junction)) { [IO.Directory]::Delete($junction, $false) }; if ($null -ne $root -and [IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) } } catch { $cleanupFailed = $true }
	if ($cleanupFailed) { $stage = 'cleanup'; $completed = $false }
	Write-Result $completed $stage $architecture $elevated
	if (-not $completed) { exit 1 }
}
