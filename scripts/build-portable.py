"""Build or verify a clean Windows portable ZIP without reading personal data."""
from pathlib import Path, PureWindowsPath
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile

VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')
ROOT_FILES = {
    'cindervault.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'd3dcompiler_47.dll', 'dependencies.json', 'dxcompiler.dll', 'dxil.dll',
    'ffmpeg.dll', 'icudtl.dat', 'license', 'licenses.chromium.html',
    'readme-cn.txt', 'resources.pak', 'snapshot_blob.bin', 'third-party-notices.md',
    'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json',
    'vk_swiftshader.dll', 'vulkan-1.dll', 'windows-validation.txt',
}
REQUIRED_RUNTIME = {
    'CinderVault.exe', 'resources/bin/ffmpeg.exe', 'resources/bin/ffprobe.exe',
    'resources/bin/node.exe', 'resources/bin/yt-dlp.exe', 'LICENSE',
    'DEPENDENCIES.json', 'THIRD-PARTY-NOTICES.md',
    'third_party/sources/SOURCE-MANIFEST.json',
}
APP_ROOTS = {'assets', 'lib', 'native', 'ui', 'test'}
APP_FILES = {'main.js', 'preload.js', 'package.json', 'package-lock.json'}
IGNORED_NAMES = {'data', 'logs', '.git', 'node_modules', 'vendor', '__pycache__'}
DOCS = ('README-CN.txt', 'WINDOWS-VALIDATION.txt')


def sha256(file):
    with file.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def validate_version(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError('Package version must be a safe semantic version')
    return version


def ignored_name(name):
    lowered = name.casefold()
    return (lowered in IGNORED_NAMES or lowered.startswith('.env')
            or lowered.endswith(('.log', '.tmp', '.pyc', '.sqlite', '.sqlite3', '.db', '.pem', '.key')))


def relative_parts(relative):
    if (not isinstance(relative, str) or not relative or '\\' in relative
            or any(ord(char) < 32 for char in relative) or ':' in relative
            or PureWindowsPath(relative).is_absolute() or relative.startswith('/')):
        raise ValueError(f'Invalid package path: {relative!r}')
    parts = relative.split('/')
    if any(not part or part in ('.', '..') or part.rstrip(' .') != part
           or re.match(r'^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)', part, re.I)
           or any(char in part for char in '<>"|?*') for part in parts):
        raise ValueError(f'Invalid package path: {relative!r}')
    if any(ignored_name(part) for part in parts):
        raise ValueError(f'Private/runtime-state path is forbidden: {relative!r}')
    return parts


def allowed_package_path(relative):
    parts = relative_parts(relative)
    lowered = [part.casefold() for part in parts]
    allowed = (len(parts) == 1 and lowered[0] in ROOT_FILES
               or lowered[0] in {'licenses', 'locales', 'backgrounds'} and len(parts) > 1
               or lowered[:2] == ['third_party', 'sources'] and len(parts) > 2
               or lowered[:2] == ['resources', 'bin'] and len(parts) == 3 and lowered[2] in {'ffmpeg.exe', 'ffprobe.exe', 'node.exe', 'yt-dlp.exe'}
               or lowered[:2] == ['resources', 'app'] and len(parts) > 2 and (lowered[2] in APP_ROOTS or len(parts) == 3 and lowered[2] in APP_FILES))
    if not allowed:
        raise ValueError(f'Unexpected package layout: {relative!r}')
    return parts


def reject_links(file):
    """Check the unresolved path: resolve() would hide symlinks and junctions."""
    absolute = Path(os.path.abspath(file))
    for item in (*reversed(absolute.parents), absolute):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
            raise ValueError(f'Symbolic links and junctions are not permitted: {item}')


def safe_path(root, relative):
    parts = relative_parts(relative)
    root = Path(root)
    target = root.joinpath(*parts)
    reject_links(target)
    resolved = target.resolve()
    if root.resolve() not in resolved.parents:
        raise ValueError(f'Invalid package path: {relative!r}')
    return target


def validate_manifest(manifest, expected_version=None):
    if (not isinstance(manifest, dict) or manifest.get('schema_version') != 1
            or manifest.get('product') != 'CinderVault' or manifest.get('target') != 'win32-x64'
            or manifest.get('personal_data_included') is not False):
        raise ValueError('Unsupported or unsafe package manifest')
    version = validate_version(manifest.get('version'))
    if expected_version is not None and version != expected_version:
        raise ValueError('Archive version does not match app/package.json')
    records = manifest.get('files')
    if not isinstance(records, list) or not records or len(records) > 10000:
        raise ValueError('Invalid manifest file count')
    seen = set()
    for entry in records:
        if not isinstance(entry, dict):
            raise ValueError('Invalid manifest entry')
        relative = entry.get('path')
        allowed_package_path(relative)
        if relative.casefold() in seen:
            raise ValueError(f'Duplicate Windows package path: {relative}')
        seen.add(relative.casefold())
        if (type(entry.get('bytes')) is not int or entry['bytes'] < 0
                or not isinstance(entry.get('sha256'), str) or not HASH.fullmatch(entry['sha256'])):
            raise ValueError(f'Invalid checksum record: {relative}')
    if not {entry.casefold() for entry in REQUIRED_RUNTIME}.issubset(seen):
        raise ValueError('Required runtime, license or source-manifest files are missing')
    return records


def source_files(repo):
    app = repo / 'app'
    reject_links(app)
    files = []
    for root, directories, filenames in os.walk(app, followlinks=False):
        # Never recurse into or read personal data, environment files, or logs.
        directories[:] = sorted(name for name in directories if not ignored_name(name))
        for name in directories:
            reject_links(Path(root) / name)
        for name in sorted(filenames):
            if ignored_name(name):
                continue
            file = Path(root) / name
            relative = file.relative_to(app).as_posix()
            allowed_package_path('resources/app/' + relative)
            reject_links(file)
            if not file.is_file():
                raise ValueError(f'Invalid source file: {relative}')
            files.append((file, 'resources/app/' + relative))
    if not {'resources/app/main.js', 'resources/app/preload.js', 'resources/app/package.json'}.issubset({relative for _, relative in files}):
        raise ValueError('Required application source files are missing')
    for name in DOCS:
        file = safe_path(repo, 'docs/' + name)
        if not file.is_file():
            raise ValueError(f'Required documentation is missing: {name}')
        files.append((file, name))
    return files


def verify_archive(archive, expected_version=None, source_root=None):
    reject_links(archive)
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if not members or len(members) > 10001:
            raise ValueError('Invalid archive member count')
        roots = {member.filename.split('/')[0] for member in members}
        if len(roots) != 1:
            raise ValueError('Archive must have exactly one product directory')
        root = roots.pop()
        relative_parts(root)
        manifest_name = root + '/PACKAGE-MANIFEST.json'
        try:
            info = bundle.getinfo(manifest_name)
        except KeyError as error:
            raise ValueError('Archive package manifest is missing') from error
        if info.file_size > 10 * 1024 * 1024:
            raise ValueError('Archive package manifest is too large')
        manifest = json.loads(bundle.read(info).decode('utf-8-sig'))
        records = validate_manifest(manifest, expected_version)
        if source_root is not None:
            source = source_files(Path(source_root))
            actual = {entry['path']: entry for entry in records if entry['path'].startswith('resources/app/') or entry['path'] in DOCS}
            if set(actual) != {relative for _, relative in source}:
                raise ValueError('Archive source/document files do not match this repository')
            for file, relative in source:
                if file.stat().st_size != actual[relative]['bytes'] or sha256(file) != actual[relative]['sha256']:
                    raise ValueError(f'Archive source differs from this repository: {relative}')
        if root != f'CinderVault-{manifest["version"]}-Windows-x64':
            raise ValueError('Archive directory/version mismatch')
        expected = {root + '/' + entry['path']: entry for entry in records}
        seen = set()
        for member in members:
            if member.filename.casefold() in seen or member.is_dir() or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError('Archive contains duplicate, directory or symbolic-link members')
            seen.add(member.filename.casefold())
            if member.filename == manifest_name:
                continue
            entry = expected.pop(member.filename, None)
            if entry is None or member.file_size != entry['bytes']:
                raise ValueError(f'Archive differs from its manifest: {member.filename}')
            with bundle.open(member) as handle:
                if hashlib.file_digest(handle, 'sha256').hexdigest() != entry['sha256']:
                    raise ValueError(f'Archive checksum mismatch: {member.filename}')
        if expected:
            raise ValueError('Archive is missing files listed in its manifest')
        return manifest


def build(repo, base, output):
    repo, base, output = Path(repo), Path(base), Path(output)
    for location in (repo, base, output):
        reject_links(location)
    repo, base, output = repo.resolve(), base.resolve(), output.resolve()
    if output.exists() or any(output == root or root in output.parents or output in root.parents for root in (base, repo)):
        raise ValueError('Output must be a new directory outside the base bundle and repository')
    version = validate_version(json.loads(safe_path(repo, 'app/package.json').read_text(encoding='utf-8-sig')).get('version'))
    manifest_file = safe_path(base, 'PACKAGE-MANIFEST.json')
    if manifest_file.stat().st_size > 10 * 1024 * 1024:
        raise ValueError('Base package manifest is too large')
    manifest = json.loads(manifest_file.read_text(encoding='utf-8-sig'))
    records = validate_manifest(manifest)
    sources = source_files(repo)
    # Verify every listed base file before making the output directory.
    for entry in records:
        src = safe_path(base, entry['path'])
        if not src.is_file() or src.stat().st_size != entry['bytes'] or sha256(src) != entry['sha256']:
            raise ValueError(f'Base bundle checksum mismatch: {entry["path"]}')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.cindervault-build-', dir=output.parent))
    try:
        product = stage / f'CinderVault-{version}-Windows-x64'
        for entry in records:
            if entry['path'].casefold().startswith('resources/app/') or entry['path'].casefold() in {name.casefold() for name in DOCS}:
                continue
            dst = safe_path(product, entry['path'])
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(safe_path(base, entry['path']), dst)
        for src, relative in sources:
            reject_links(src)
            dst = safe_path(product, relative)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        files = sorted(file for file in product.rglob('*') if file.is_file())
        release = {'schema_version': 1, 'product': 'CinderVault', 'version': version, 'target': 'win32-x64', 'unsigned': True, 'personal_data_included': False, 'files': [
            {'path': file.relative_to(product).as_posix(), 'bytes': file.stat().st_size, 'sha256': sha256(file)} for file in files
        ]}
        validate_manifest(release, version)
        package_manifest = product / 'PACKAGE-MANIFEST.json'
        package_manifest.write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        archive = stage / f'{product.name}.zip'
        with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for file in files + [package_manifest]:
                bundle.write(file, (Path(product.name) / file.relative_to(product)).as_posix())
        verify_archive(archive, version)
        checksum = sha256(archive)
        Path(str(archive) + '.sha256').write_text(f'{checksum}  {archive.name}\n', encoding='utf-8')
        size = archive.stat().st_size
        stage.rename(output)
        return {'archive': str(output / archive.name), 'sha256': checksum, 'files': len(release['files']), 'bytes': size}
    finally:
        # Only this invocation's generated staging directory may be removed.
        if stage.exists() and stage.parent == output.parent and stage.name.startswith('.cindervault-build-'):
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--base', type=Path, help='Extracted trusted CinderVault portable directory')
    mode.add_argument('--verify-archive', type=Path, help='Verify a ZIP against its internal manifest without extracting')
    parser.add_argument('--output', type=Path, help='New, nonexistent build directory')
    parser.add_argument('--expected-version', help='Require this version when verifying an archive')
    parser.add_argument('--source-root', type=Path, help='Also match archived app/docs to this repository when verifying')
    args = parser.parse_args()
    if args.verify_archive:
        manifest = verify_archive(args.verify_archive, args.expected_version, args.source_root)
        print(json.dumps({'verified': True, 'version': manifest['version'], 'files': len(manifest['files'])}))
    else:
        if not args.output:
            parser.error('--output is required with --base')
        print(json.dumps(build(Path(__file__).resolve().parent.parent, args.base, args.output)))


if __name__ == '__main__':
    main()
