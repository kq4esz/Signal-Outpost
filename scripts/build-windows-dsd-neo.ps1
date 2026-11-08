[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $repoRoot 'native/digital/manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$archive = Join-Path $repoRoot 'native/digital/source/dsd-neo-32ae7c8.zip'
$expectedArchiveHash = [string]$manifest.sourceArchiveSha256
$actualArchiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualArchiveHash -ne $expectedArchiveHash) {
    throw "Pinned DSD-neo source archive hash mismatch: expected $expectedArchiveHash, got $actualArchiveHash."
}
if (-not $env:VCPKG_ROOT -or -not (Test-Path -LiteralPath (Join-Path $env:VCPKG_ROOT 'scripts/buildsystems/vcpkg.cmake'))) {
    throw 'The pinned vcpkg toolchain is unavailable. Set up the DSD-neo vcpkg baseline before this build.'
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = (Resolve-Path -LiteralPath $tempRoot).Path
$buildRoot = Join-Path $tempRoot ("signal-outpost-dsd-neo-wfm-{0}" -f [guid]::NewGuid().ToString('N'))
$sourceArchiveRoot = Join-Path $buildRoot 'source'
$stageBin = Join-Path $buildRoot 'runtime/bin'
New-Item -ItemType Directory -Path $sourceArchiveRoot,$stageBin -Force | Out-Null

try {
    Expand-Archive -LiteralPath $archive -DestinationPath $sourceArchiveRoot
    $source = Get-ChildItem -LiteralPath $sourceArchiveRoot -Directory | Select-Object -First 1 -ExpandProperty FullName
    if (-not $source) { throw 'The pinned DSD-neo source archive did not contain a source directory.' }

    & node (Join-Path $repoRoot 'scripts/apply-dsd-neo-source-patches.mjs') $source
    if ($LASTEXITCODE -ne 0) { throw "Applying the DSD-neo source patch failed with exit code $LASTEXITCODE." }

    $triplet = 'x64-windows-dynamic-release'
    $vcpkg = Get-Command vcpkg.exe -ErrorAction SilentlyContinue
    if ($vcpkg) {
        $vcpkgCommand = $vcpkg.Source
    } else {
        $vcpkgCommand = Join-Path $env:VCPKG_ROOT 'vcpkg.exe'
    }
    if (-not (Test-Path -LiteralPath $vcpkgCommand)) { throw "vcpkg.exe was not found at $vcpkgCommand." }

    & $vcpkgCommand install --triplet $triplet --overlay-triplets (Join-Path $source 'vcpkg-triplets') --x-manifest-root $source
    if ($LASTEXITCODE -ne 0) { throw "vcpkg dependency installation failed with exit code $LASTEXITCODE." }

    Push-Location $source
    try {
        & cmake --preset win-msvc-release -G Ninja `
            -DDSD_ENABLE_API=ON `
            -DDSD_ENABLE_RTLSDR=ON `
            -DDSD_REQUIRE_RTLSDR=ON `
            -DDSD_ENABLE_AIRSPY=ON `
            -DDSD_REQUIRE_AIRSPY=ON `
            -DDSD_ENABLE_SOAPYSDR=ON `
            -DDSD_REQUIRE_SOAPYSDR=ON `
            -DDSD_ENABLE_TERMINAL_UI=OFF `
            -DDSD_AUDIO_BACKEND=none `
            -DDSD_WARNINGS_AS_ERRORS=OFF
        if ($LASTEXITCODE -ne 0) { throw "DSD-neo CMake configure failed with exit code $LASTEXITCODE." }

        & cmake --build --preset win-msvc-release --parallel
        if ($LASTEXITCODE -ne 0) { throw "DSD-neo build failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }

    $exe = Get-ChildItem -LiteralPath (Join-Path $source 'build/win-msvc-release/apps/dsd-cli') -Recurse -Filter 'dsd-neo.exe' |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $exe) { throw 'The DSD-neo Windows build did not produce dsd-neo.exe.' }
    Copy-Item -LiteralPath $exe -Destination (Join-Path $stageBin 'dsd-neo.exe') -Force

    $vcpkgBin = Join-Path $source "vcpkg_installed/$triplet/bin"
    if (-not (Test-Path -LiteralPath $vcpkgBin)) { throw "The vcpkg runtime DLL directory was not found: $vcpkgBin" }
    & (Join-Path $source 'tools/windows/stage_runtime_dlls.ps1') `
        -TargetBinary (Join-Path $stageBin 'dsd-neo.exe') `
        -DestinationDir $stageBin `
        -SearchDirs @($vcpkgBin)

    $runtimeBin = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'native/digital/win32-x64/bin'))
    $repoPrefix = $repoRoot.TrimEnd([char[]]@('\','/')) + [System.IO.Path]::DirectorySeparatorChar
    if ((-not $runtimeBin.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) -or (-not (Test-Path -LiteralPath $runtimeBin))) {
        throw "Refusing to stage the decoder into an unexpected runtime directory: $runtimeBin"
    }
    $existing = @(Get-ChildItem -LiteralPath $runtimeBin -Force)
    if ($existing | Where-Object { $_.PSIsContainer }) {
        throw "Refusing to replace a runtime directory that contains nested paths: $runtimeBin"
    }
    foreach ($file in $existing) { Remove-Item -LiteralPath $file.FullName -Force }
    Copy-Item -Path (Join-Path $stageBin '*') -Destination $runtimeBin -Force

    & node (Join-Path $repoRoot 'scripts/record-windows-native-manifest.mjs')
    if ($LASTEXITCODE -ne 0) { throw "Recording the DSD-neo Windows manifest failed with exit code $LASTEXITCODE." }
} finally {
    $resolvedBuildRoot = [System.IO.Path]::GetFullPath($buildRoot)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot).TrimEnd('\','/') + [System.IO.Path]::DirectorySeparatorChar
    if ($resolvedBuildRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
