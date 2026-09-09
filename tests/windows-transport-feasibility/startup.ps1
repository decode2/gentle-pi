$ErrorActionPreference = "Stop"
$utf8 = [Text.UTF8Encoding]::new($false)
$OutputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$started = [Diagnostics.Stopwatch]::StartNew()
$psVersion = [Regex]::Replace($PSVersionTable.PSVersion.ToString(), "[^0-9.]", "")
$dotNetVersion = [Regex]::Replace([Environment]::Version.ToString(), "[^0-9.]", "")
$elapsedMs = [int]$started.ElapsedMilliseconds
$line = "{`"stage`":`"startup-control`",`"status`":`"observed`",`"details`":{`"protocol`":`"ascii-jsonl-v1`",`"powershellVersion`":`"$psVersion`",`"dotNetVersion`":`"$dotNetVersion`",`"elapsedMs`":$elapsedMs}}"
[Console]::Out.WriteLine($line)
[Console]::Out.Flush()
exit 0
