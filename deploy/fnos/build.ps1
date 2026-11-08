param(
    [ValidateSet('Native')][string]$Mode = 'Native',
    [string]$Fnpack = 'C:/Tools/fnpack/fnpack.exe',
    [string]$OutputDir = (Join-Path $env:TEMP 'wuchengerp-fpk-builds')
)
$ErrorActionPreference = 'Stop'
# Windows fnpack.exe cannot install Linux production dependencies or verify ELF.
# Linux owns the manifest/config/privilege/loading-logo.png allowlist and SHA256,
# using official fnpack build --directory. Never generate a thin entry again.
throw '完整原生 FPK 必须在 Debian 12 x86_64 使用 deploy/fnos/build-native.sh 构建。推送代码后运行 GitHub 的 fnOS native FPK 工作流并下载 FPK、SHA256 和对应源码产物。此 Windows 入口不再生成薄入口包。'
