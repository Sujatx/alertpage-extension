# Updates the AlertPage extension folder in place from the latest GitHub release.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PS 5.1's progress bar makes Invoke-WebRequest very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Change if your folder is elsewhere.
$ExtensionDir = 'C:\AlertPage\extension'

$base = 'https://github.com/Sujatx/alertpage-extension/releases/latest/download/'
$tmp = Join-Path $env:TEMP ('alertpage-update-' + [guid]::NewGuid())
$failed = $false

try {
    if (-not (Test-Path (Join-Path $ExtensionDir 'manifest.json'))) {
        throw "Extension folder not found or has no manifest.json: $ExtensionDir"
    }
    $oldVersion = (Get-Content (Join-Path $ExtensionDir 'manifest.json') -Raw | ConvertFrom-Json).version

    New-Item -ItemType Directory -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'alertpage-extension.zip'
    $sha = Join-Path $tmp 'alertpage-extension.zip.sha256'
    try {
        Write-Host 'Downloading latest release...'
        Invoke-WebRequest -UseBasicParsing -Uri ($base + 'alertpage-extension.zip') -OutFile $zip
        Invoke-WebRequest -UseBasicParsing -Uri ($base + 'alertpage-extension.zip.sha256') -OutFile $sha
    } catch {
        throw "Download failed (check your internet connection): $($_.Exception.Message)"
    }

    $expected = ((Get-Content $sha -Raw).Trim() -split '\s+')[0]
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash
    if ($actual -ine $expected) {
        throw 'Download is corrupted (checksum mismatch). Nothing was changed. Try again.'
    }

    $x = Join-Path $tmp 'x'
    Expand-Archive -Path $zip -DestinationPath $x
    $src = $x
    if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
        $kids = @(Get-ChildItem $x)
        if ($kids.Count -eq 1 -and $kids[0].PSIsContainer) { $src = $kids[0].FullName }
    }
    $mf = Join-Path $src 'manifest.json'
    if (-not (Test-Path $mf)) { throw 'The downloaded update has no manifest.json. Nothing was changed.' }
    $newVersion = (Get-Content $mf -Raw | ConvertFrom-Json).version
    if (-not $newVersion) { throw 'The downloaded update has no version. Nothing was changed.' }

    Get-ChildItem $ExtensionDir -Force | Remove-Item -Recurse -Force
    Get-ChildItem $src -Force | Copy-Item -Destination $ExtensionDir -Recurse -Force

    Write-Host "Updated: $oldVersion -> $newVersion"
    Write-Host 'Now click the reload button on the AlertPage extension'
    try { Start-Process chrome 'chrome://extensions' } catch { }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $failed = $true
} finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
if ($failed) { exit 1 }
