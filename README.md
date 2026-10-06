# 烬匣 CinderVault

中文 Windows 便携视频下载器。支持 YouTube 单视频和频道、B站视频、Twitch 回放和剪辑。

## 1.0.5

- 扫描频道后浏览视频标题、搜索、分页与勾选；默认不选任何视频。
- 下载所选视频，也可明确全选后取消个别视频。
- 频道区域直接选择最佳可用画质、1080p、720p、480p 或 MP3；与单视频设置同步。
- 新下载文件名加入平台提供的发布日期，例如 `2022-07-29 视频标题 [ID]-720.mp4`。缺少日期标注“日期未知”，不拿下载时间代替。
- 保留历史去重、暂停/续传、失败重试、频道文件夹、扫描取消与不完整结果提示。

## 使用

在 [Releases](https://github.com/BlackMambaCafe/CinderVault/releases) 下载 Windows x64 便携包，完整解压后运行 `CinderVault.exe`，无需另装 Node、Python 或 FFmpeg。

粘贴频道主页，点击扫描，勾选想下载的视频，再选择画质并下载所选。最高画质表示平台当前可用的最佳格式，1080p/720p/480p 是分辨率上限；MP3 只保存音频。

已下载历史按视频、画质、保存位置区分。旧版本未完成的任务保持原来的文件命名以接续分片；已有文件不会批量重命名。

## 源码与测试

`app/` 包含完整 Electron 应用源码，原生窗口图标辅助程序源码在 `app/native/`。使用 Node 24+：

```powershell
cd app
npm run check
npm test
cd ..
python -m unittest discover -s scripts -p "test_*.py" -v
```

这些测试离线运行，不下载真实视频。打包测试需要 Python 3.11+；发布检查测试还需要 PowerShell 7 和 Git，只在临时目录创建本地测试仓库，不连接 GitHub。真实网络与原生窗口验收范围见 [验收说明](docs/WINDOWS-VALIDATION.txt)。

## 打包

Electron、Node、yt-dlp、FFmpeg 运行时通过便携包分发，不提交到 Git。使用 Python 3.11+，打包脚本使用可信便携包作为运行时底座，按清单逐文件校验，再替换 `app/` 源码并生成全新 ZIP 与 SHA256。它不读取或复制底座中的个人 data 目录；拒绝路径越界、符号链接、Windows 联接、重复文件名及包含个人数据的清单。校验完整通过后才生成最终输出目录。

```powershell
python scripts/build-portable.py --base "D:\CinderVault-1.0.4" --output "D:\build-1.0.5"
```

底座可以是完整解压的 1.0.4 或布局兼容的后续便携包；必须保留 `PACKAGE-MANIFEST.json`、许可证及第三方对应源码。输出目录须位于底座和源码仓库之外，且尚不存在。清单校验用于检查内容一致性，底座本身应来自可信来源；这个脚本不宣称从零编译第三方运行时。

## 版本发布

已提供 Windows CI 配置和 `scripts/publish-release.ps1`。发布需要先配置目标 GitHub 账号并安装官方 GitHub CLI，以显式 `账号/仓库` 参数执行脚本；首次创建时选择仓库可见性。脚本先检查 ZIP 内外校验、当前版本、包内源码与本地源码一致性，以及 main 分支、干净提交、标签、发布说明和 origin，再推送源码并生成草稿 Release；不会覆盖已有版本。支持先用 `-ValidateOnly` 完成本地检查，不登录或修改 GitHub。

```powershell
./scripts/publish-release.ps1 -Repository "你的账号/CinderVault" -Archive "D:\build-1.0.5\CinderVault-1.0.5-Windows-x64.zip" -CreateRepository -Visibility public
```

脚本完成后仍是草稿 Release，需要在 GitHub 页面核对附件并手动发布。源码推送和创建 Release 是两个操作：若后一步失败，脚本会明确报告源码已推送，请核对页面后再重试。后续版本使用相同命令并去掉 `-CreateRepository`。

程序内现有“一键更新”只更新 yt-dlp 引擎；应用本体新版通过 Release 下载完整包，退出旧版后复制自己的 `data` 文件夹到新目录即可保留设置、队列、频道扫描和下载历史。不要把带个人 data 的包发给别人。

## 许可与限制

应用源码采用 MIT；第三方组件适用各自许可，见 [第三方说明](THIRD-PARTY-NOTICES.md) 和依赖记录。公开视频也可能因平台验证、地区、下架等限制而失败。不读取浏览器凭据，不录制进行中的直播。
