param([string]$Config, [switch]$Prepare, [switch]$NoDialog)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$work = [IO.Path]::GetFullPath($settings.work)
$target = [IO.Path]::GetFullPath($settings.target)
$parent = [IO.Path]::GetDirectoryName($target)
if ([IO.Path]::GetDirectoryName($work) -ne $parent -or -not ([IO.Path]::GetFileName($work).StartsWith('.daily-drop-update-'))) { throw 'Invalid update workspace' }
$staged = Join-Path $work $settings.folder
$backup = Join-Path $work 'previous'
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($staged)) -ne $work) { throw 'Invalid staging path' }
if ($Prepare) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($settings.archive)
  try {
    $total = 0
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName.Contains(':') -or [IO.Path]::IsPathRooted($entry.FullName)) { throw 'Unsafe archive path' }
      $path = [IO.Path]::GetFullPath((Join-Path $work $entry.FullName))
      if (-not $path.StartsWith($staged + '\', [StringComparison]::OrdinalIgnoreCase) -and $path -ne $staged) { throw 'Unsafe archive path' }
      if (($entry.ExternalAttributes -band 0xF0000000) -eq 0xA0000000) { throw 'Archive links are not supported' }
      $total += $entry.Length
      if ($total -gt 2GB) { throw 'Archive too large' }
    }
    [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, $work)
  } finally { $zip.Dispose() }
  $manifest = Get-Content -LiteralPath (Join-Path $staged 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.version -ne $settings.version -or $manifest.name -ne 'valorant-daily-drop' -or -not (Test-Path -LiteralPath (Join-Path $staged 'DailyDrop.exe'))) { throw 'Invalid application package' }
  exit 0
}
Set-Content -LiteralPath (Join-Path $work 'ready') -Value 'ready'
try {
  $running = Get-Process -Id $settings.pid -ErrorAction SilentlyContinue
  if ($running -and -not $running.WaitForExit(60000)) { throw 'Application did not exit' }
  # Rename only the verified installation and its sibling staging directory.
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { Move-Item -LiteralPath $target -Destination $backup; break } catch { if ($attempt -eq 29) { throw }; Start-Sleep -Milliseconds 500 }
  }
  try {
    Move-Item -LiteralPath $staged -Destination $target
    Start-Process -FilePath (Join-Path $target 'DailyDrop.exe') -WorkingDirectory $target -WindowStyle Hidden
  } catch {
    if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination (Join-Path $work 'failed') }
    Move-Item -LiteralPath $backup -Destination $target
    throw
  }
} catch {
  Set-Content -LiteralPath (Join-Path $work 'error.txt') -Value $_.Exception.Message
  if (Test-Path -LiteralPath (Join-Path $target 'DailyDrop.exe')) { Start-Process -FilePath (Join-Path $target 'DailyDrop.exe') -WorkingDirectory $target -WindowStyle Hidden }
  if (-not $NoDialog) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('Update failed. The previous version has been retained. Details: ' + $work, 'DAILY DROP') | Out-Null
  }
  exit 1
}
