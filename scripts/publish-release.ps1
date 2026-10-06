param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$')][string]$Repository,
  [Parameter(Mandatory=$true)][string]$Archive,
  [switch]$CreateRepository,
  [ValidateSet('public','private')][string]$Visibility = 'private',
  [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Get-Command git -ErrorAction Stop | Out-Null
Get-Command python -ErrorAction Stop | Out-Null
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw '发布包必须是 ZIP 文件' }
$checksumPath = $archivePath + '.sha256'
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'app/package.json') -Raw | ConvertFrom-Json).version
if ($version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$') { throw '版本号格式无效' }
$tag = 'v' + $version
$notesPath = Join-Path $repoRoot ('releases/' + $tag + '.md')
if (-not (Test-Path -LiteralPath $notesPath -PathType Leaf) -or [string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $notesPath -Raw))) { throw '当前版本缺少发布说明' }
if ([IO.Path]::GetFileName($archivePath) -cne ('CinderVault-' + $version + '-Windows-x64.zip')) { throw '发布包文件名与当前版本不一致' }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw '缺少包的 SHA256 校验文件' }
$checksumLine = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
if ($checksumLine -cnotmatch '^([0-9a-f]{64})  ([^\r\n]+)$') { throw 'SHA256 校验文件格式无效' }
$expected = $Matches[1]
if ($Matches[2] -cne [IO.Path]::GetFileName($archivePath)) { throw 'SHA256 校验文件指向其他文件' }
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw '发布包校验失败' }

Push-Location $repoRoot
try {
  # Complete local validation before authentication or any GitHub mutation.
  & python (Join-Path $PSScriptRoot 'build-portable.py') --verify-archive $archivePath --expected-version $version --source-root $repoRoot
  if ($LASTEXITCODE -ne 0) { throw '发布包内部文件校验或源码一致性校验失败' }
  $gitRoot = & git rev-parse --show-toplevel
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($gitRoot.Trim()) -ne [IO.Path]::GetFullPath($repoRoot)) { throw '发布脚本必须位于独立源码仓库中' }
  $branch = & git branch --show-current
  if ($LASTEXITCODE -ne 0 -or $branch -cne 'main') { throw '请在 main 分支发布，不能从其他分支或游离 HEAD 发布' }
  $dirty = & git status --porcelain --untracked-files=all
  if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 状态' }
  if ($dirty) { throw '发布前请提交本地修改，包括发布说明' }
  $head = & git rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0 -or $head -cnotmatch '^[0-9a-f]{40,64}$') { throw '源码仓库还没有可发布的提交' }
  $localTag = & git tag --list $tag
  if ($LASTEXITCODE -ne 0) { throw '无法读取本地标签' }
  if ($localTag) {
    $tagCommit = & git rev-list -n 1 $tag
    if ($LASTEXITCODE -ne 0 -or $tagCommit -ne $head) { throw '同名版本标签指向其他提交；请增加版本号，不要覆盖已有版本' }
  }
  $remotes = & git remote
  if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 远程仓库配置' }
  $hasOrigin = @($remotes) -contains 'origin'
  if ($CreateRepository -and $hasOrigin) { throw 'origin 已存在；请核对仓库后去掉 CreateRepository 参数' }
  if (-not $CreateRepository) {
    if (-not $hasOrigin) { throw '尚未设置 origin；首次发布请明确使用 CreateRepository' }
    $remote = & git remote get-url origin
    $allowedRemotes = @(('https://github.com/' + $Repository + '.git'), ('git@github.com:' + $Repository + '.git'), ('https://github.com/' + $Repository))
    if ($LASTEXITCODE -ne 0 -or $allowedRemotes -notcontains $remote) { throw 'origin 与指定仓库不一致，已停止' }
  }
  if ($ValidateOnly) {
    Write-Output ('本地发布检查通过：' + $Repository + ' / ' + $tag + ' / ' + $head + '。未登录、创建、推送或发布任何内容。')
    return
  }
  Get-Command gh -ErrorAction Stop | Out-Null
  & gh auth status --hostname github.com
  if ($LASTEXITCODE -ne 0) { throw '请先用 gh auth login 登录目标 GitHub 账号' }
  if ($CreateRepository) {
    & gh repo create $Repository ('--' + $Visibility) --source . --remote origin
    if ($LASTEXITCODE -ne 0) { throw '创建仓库失败，未继续发布；请核对 GitHub 和本地 origin 后重试' }
  }
  & git push -u origin 'HEAD:refs/heads/main'
  if ($LASTEXITCODE -ne 0) { throw '源码推送失败；没有创建 Release，请核对仓库状态后重试' }
  & gh release create $tag $archivePath $checksumPath --repo $Repository --target $head --title ('烬匣 ' + $version) --notes-file $notesPath --draft
  if ($LASTEXITCODE -ne 0) { throw '源码已推送；草稿 Release 创建失败或结果未确认。请检查 GitHub 页面后重试；脚本不会覆盖或删除已有版本。' }
  Write-Output '源码已推送，草稿 Release 已生成（尚未公开发布）。请核对 GitHub 页面及附件后手动发布。'
} finally { Pop-Location }
