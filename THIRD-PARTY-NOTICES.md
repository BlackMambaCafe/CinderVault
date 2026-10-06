# Third-party software / 第三方软件说明

CinderVault bundles verified upstream runtimes plus separately source-built FFmpeg/FFprobe media tools. The application communicates
with yt-dlp, FFmpeg and Node.js as separate child processes. Their licenses apply to
those components; this notice does not replace any upstream license or impose extra
restrictions on their use, modification or redistribution.

All versions, download URLs, verified SHA-256 values, file sizes and checksum sources
are recorded in `DEPENDENCIES.json`. The portable package is **unsigned**. A matching
SHA-256 verifies that a file matches the recorded upstream artifact; it is not a
claim that the complete package was signed by any upstream project.

## Electron 44.5.1

- Project and exact source: https://github.com/electron/electron/tree/v44.5.1
- Release: https://github.com/electron/electron/releases/tag/v44.5.1
- License: MIT, with additional Chromium, Node.js and other third-party notices
- The upstream Electron license is preserved as `licenses/electron-LICENSE.txt`
- The upstream `LICENSES.chromium.html` stays at the package root, unmodified
- `CinderVault.exe` is the official `electron.exe` renamed, with custom icon resources. Runtime code was not recompiled; PE version metadata still identifies Electron 44.5.1
- Linux Electron is used only for cloud testing and is not shipped in the Windows ZIP

## yt-dlp 2026.08.19

- Source: https://github.com/yt-dlp/yt-dlp/tree/2026.08.19
- Release: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19
- yt-dlp itself uses the Unlicense: `licenses/yt-dlp-LICENSE.txt`
- Its Windows PyInstaller bundle contains other software with additional licenses
- The complete upstream aggregate is preserved as
  `licenses/yt-dlp-THIRD_PARTY_LICENSES.txt`, including notices and source information
- Do not treat the entire Windows executable as public-domain-only software
- Upstream documentation is included as `licenses/yt-dlp-README.md`
- The upstream aggregate says the yt-dlp maintainers can provide bundled component
  source if it cannot be obtained from the original projects; their contact and
  wording are retained verbatim in that file

## FFmpeg / FFprobe 9.0.2 + LAME 3.100 (custom LGPL media build)

- FFmpeg exact source: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b6dcd0331c8cc609192aeff5e1924f8
- Pristine FFmpeg source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- Pristine LAME source: https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
- FFmpeg license for this configuration: LGPL version 2.1 or later
- LAME library license: LGPL version 2 or later
- Full license texts are preserved under `licenses/ffmpeg/` and `licenses/lame-COPYING.txt`
- This build does **not** contain Gyan or BtbN FFmpeg binaries
- These two Windows x64 executables were cross-compiled in the cloud, using
  LLVM-MinGW 20260922 UCRT. Their hashes identify this local build; they are not
  represented as official upstream Windows binaries
- GPL-only, nonfree, version3-only, network, capture-device and unused encoder
  support is disabled. LAME is the only optional external codec library
- Native AAC, Opus and Vorbis decoding is enabled, along with MP3, AAC, FLAC and
  PCM audio encoding, all built-in demuxers/muxers, and file/pipe I/O
- The application uses yt-dlp for network downloading and FFmpeg for local media
  merging/remuxing/audio conversion. The media tools do not accept network URLs

### Corresponding sources and rebuild instructions / 源码与重建

The exact, pristine FFmpeg and LAME source archives are included directly in
`third_party/sources/` and match the hashes recorded in `DEPENDENCIES.json`.
The saved generated FFmpeg configuration is under `licenses/ffmpeg/`.
Application source and the native Windows icon helper source are under `resources/app/`.
No modification of FFmpeg or LAME source was reported by the original build.

The original cloud source companion ZIP was not present on this Windows computer.
A rebuild recipe reconstructed from the recorded configuration accompanies the
source archives. Its README explains the source hashes, toolchain, flags and
limitations. This reconstructed recipe has not been rerun on the Windows host;
neither byte-for-byte build reproducibility nor retention of the original cloud
build logs is claimed. Keep these sources, notices and license texts together
when redistributing the binary package. The tools can be replaced or rebuilt.

The original build record reports successful FFmpeg release-signature validation
against fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`.
This Windows packaging step verifies the source archives against the recorded
SHA-256 pins; it does not claim a new independent PGP signature verification.

LLVM/compiler-rt and MinGW-w64 runtime notices are included under
`licenses/llvm-mingw-runtime/`. Toolchain source/build scripts:
https://github.com/mstorsjo/llvm-mingw/tree/20260922 . The downloaded toolchain is
only used for building, not copied into the application's runtime package.

本包媒体工具使用可重建的 LGPL 配置，随附实际使用的完整 FFmpeg/LAME 原始源码、
编译脚本、配置及许可证，没有捆绑 Gyan/BtbN 的预编译 FFmpeg。
无论私人或公开再分发，都请保留许可证，并履行相应的源码提供义务。

## Node.js 24.21.0 LTS

- Official binary: https://nodejs.org/dist/v24.21.0/win-x64/node.exe
- Exact source: https://github.com/nodejs/node/tree/v24.21.0
- Source archive: https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.xz
- License: MIT, plus bundled third-party software licenses
- The complete upstream license/third-party collection is included as
  `licenses/node-LICENSE.txt`
- This separate runtime supports yt-dlp's JavaScript challenge processing; it is
  not a system-wide Node installation

## Rebuilding and Windows validation

Use the recipe and README in `third_party/sources/` for the media build.
The application JavaScript, HTML and CSS are directly editable in `resources/app/`.
`resources/app/native/WindowIcons.cs` is the source for the small Windows sidecar;
compile as x64 winexe with the Windows .NET Framework C# compiler and retain it
beside its source. The sidecar only targets the HWND/PID/executable supplied by
its owning application and leaves all other windows alone.

The portable ZIP contains the verified Windows runtime files and complete local
assets. It uses fixed ZIP timestamps and stable file ordering for the same inputs.
`PACKAGE-MANIFEST.json` records packaged payload sizes and SHA-256 values;
the separate ZIP `.sha256` file verifies the final archive.

Native Windows execution, video playback, queue controls and short network samples
were tested after the original cloud build. See `WINDOWS-VALIDATION.txt` for the
actual scope and exclusions. No code signature, universal SmartScreen acceptance,
or successful download of every supported site's content is claimed.

## User-initiated yt-dlp updates in CinderVault 1.0.3

The bundled versions and PACKAGE-MANIFEST.json describe the initial distribution.
The user may explicitly update yt-dlp from its official stable GitHub release.
The updater verifies the release checksum and executable version before replacement,
and retains the previous engine. It does not update Electron, Node.js or FFmpeg.
The yt-dlp project license and aggregate third-party notices remain available at
https://github.com/yt-dlp/yt-dlp and in this package. Keep notices when redistributing.
