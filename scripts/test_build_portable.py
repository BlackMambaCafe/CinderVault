"""Offline packaging regression tests; only generated temporary files are read."""
from pathlib import Path
import copy
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile

SPEC = importlib.util.spec_from_file_location('portable', Path(__file__).with_name('build-portable.py'))
portable = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(portable)


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cinder-build-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.base = self.root / 'base'
        self.output = self.root / 'release'
        for name in portable.REQUIRED_RUNTIME:
            self.write(self.base / name, b'test-runtime-' + name.encode())
        self.write(self.base / 'resources/app/main.js', b'old app')
        self.write(self.repo / 'app/main.js', b'new app')
        self.write(self.repo / 'app/preload.js', b'new preload')
        self.write(self.repo / 'app/package.json', b'{"version":"1.0.5"}')
        for name in portable.DOCS:
            self.write(self.repo / 'docs' / name, b'new docs')
        self.manifest = {
            'schema_version': 1, 'product': 'CinderVault', 'version': '1.0.4',
            'target': 'win32-x64', 'unsigned': True, 'personal_data_included': False,
            'files': [{'path': file.relative_to(self.base).as_posix(), 'bytes': file.stat().st_size, 'sha256': portable.sha256(file)} for file in self.base.rglob('*') if file.is_file()]
        }
        self.save_manifest()

    def write(self, file, content):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)

    def save_manifest(self):
        (self.base / 'PACKAGE-MANIFEST.json').write_text(json.dumps(self.manifest), encoding='utf-8')

    def build(self):
        return portable.build(self.repo, self.base, self.output)

    def test_round_trip_zip_replaces_app_and_docs_ignores_personal_files(self):
        private = [self.base / 'data/queue.json', self.base / '.env', self.repo / 'app/DATA/private.json', self.repo / 'app/.env.local', self.repo / 'app/lib/session.log']
        for file in private:
            self.write(file, b'MUST NOT READ OR PACKAGE')
        original_open = Path.open

        def guarded_open(file, *args, **kwargs):
            if file in private:
                raise AssertionError('Read private file')
            return original_open(file, *args, **kwargs)

        with mock.patch.object(Path, 'open', guarded_open):
            result = self.build()
        archive = Path(result['archive'])
        manifest = portable.verify_archive(archive, '1.0.5', self.repo)
        self.assertEqual(result['sha256'], portable.sha256(archive))
        with zipfile.ZipFile(archive) as bundle:
            self.assertEqual(bundle.read('CinderVault-1.0.5-Windows-x64/resources/app/main.js'), b'new app')
            self.assertFalse(any('data/' in name.casefold() or '.env' in name or name.endswith('.log') for name in bundle.namelist()))
        self.assertEqual(manifest['version'], '1.0.5')
        self.assertTrue(Path(str(archive) + '.sha256').is_file())

    def test_rejects_windows_path_tricks_private_names_and_bad_metadata(self):
        unsafe = ['../secret.txt', '/secret.txt', 'C:/secret.txt', 'licenses\\secret.txt', 'data/queue.json', 'DATA/queue.json', '.git/config', 'licenses/.env.local', 'licenses/session.LOG', 'licenses/file:secret', 'licenses/CON', 'licenses/file.', 'licenses//file', 'licenses/../file']
        for relative in unsafe:
            with self.subTest(relative=relative):
                manifest = copy.deepcopy(self.manifest)
                manifest['files'].append({'path': relative, 'bytes': 0, 'sha256': '0' * 64})
                with self.assertRaises(ValueError):
                    portable.validate_manifest(manifest)
        for key, value in [('version', '../escape'), ('target', 'linux-x64'), ('personal_data_included', True), ('schema_version', 99)]:
            manifest = copy.deepcopy(self.manifest)
            manifest[key] = value
            with self.assertRaises(ValueError):
                portable.validate_manifest(manifest)

    def test_case_collisions_missing_runtime_and_changed_base_fail_before_output(self):
        manifest = copy.deepcopy(self.manifest)
        entry = copy.deepcopy(manifest['files'][0])
        entry['path'] = entry['path'].upper()
        manifest['files'].append(entry)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            portable.validate_manifest(manifest)
        manifest['files'] = [entry for entry in self.manifest['files'] if entry['path'] != 'CinderVault.exe']
        with self.assertRaisesRegex(ValueError, 'missing'):
            portable.validate_manifest(manifest)
        self.write(self.base / 'CinderVault.exe', b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_output_cannot_overwrite_or_overlap_base_or_repository(self):
        for output in [self.base, self.base / 'nested', self.repo / 'build', self.root]:
            with self.subTest(output=output), self.assertRaises(ValueError):
                portable.build(self.repo, self.base, output)
        self.write(self.repo / 'app/package.json', b'{"version":"../../escape"}')
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_symlink_sources_and_linked_parent_are_rejected_before_resolving(self):
        target = self.root / 'outside'
        target.mkdir()
        self.write(target / 'secret.js', b'secret')
        link = self.repo / 'app/lib'
        try:
            os.symlink(target, link, target_is_directory=True)
        except OSError as error:
            if os.name != 'nt':
                self.skipTest(f'Host does not permit temporary symlinks: {error}')
            # Junction creation needs no symlink privilege on Windows. Both
            # paths are generated inside this test's temporary directory.
            result = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(link), str(target)], capture_output=True)
            if result.returncode:
                self.skipTest('Host does not permit temporary symlinks or junctions')
        with self.assertRaisesRegex(ValueError, 'links|junctions'):
            portable.safe_path(self.repo, 'app/lib/secret.js')
        with self.assertRaisesRegex(ValueError, 'links|junctions'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_windows_junction_attribute_is_rejected(self):
        original = Path.lstat
        target = self.base / 'CinderVault.exe'

        def reparse(file, *args, **kwargs):
            if file == target:
                info = mock.Mock(st_mode=stat.S_IFREG, st_file_attributes=0x400)
                return info
            return original(file, *args, **kwargs)

        with mock.patch.object(Path, 'lstat', reparse), self.assertRaisesRegex(ValueError, 'junctions'):
            portable.safe_path(self.base, 'CinderVault.exe')

    def test_archive_extra_traversal_wrong_version_source_tamper_and_data_are_rejected(self):
        archive = Path(self.build()['archive'])
        with self.assertRaisesRegex(ValueError, 'version'):
            portable.verify_archive(archive, '9.9.9')
        self.write(self.repo / 'app/main.js', b'not the packaged commit')
        with self.assertRaisesRegex(ValueError, 'source differs'):
            portable.verify_archive(archive, '1.0.5', self.repo)
        for index, name in enumerate(['CinderVault-1.0.5-Windows-x64/../../escape.txt', 'CinderVault-1.0.5-Windows-x64/data/queue.json']):
            corrupted = self.root / f'bad-{index}.zip'
            corrupted.write_bytes(archive.read_bytes())
            with zipfile.ZipFile(corrupted, 'a') as bundle:
                bundle.writestr(name, b'not allowed')
            with self.assertRaisesRegex(ValueError, 'manifest'):
                portable.verify_archive(corrupted)

    def test_failed_build_removes_only_its_stage_and_leaves_no_release(self):
        with mock.patch.object(portable, 'verify_archive', side_effect=ValueError('simulated verification failure')):
            with self.assertRaisesRegex(ValueError, 'simulated'):
                self.build()
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('.cindervault-build-*')), [])
        self.assertTrue((self.base / 'CinderVault.exe').is_file())

    def test_publish_validate_only_checks_real_git_zip_and_source_without_github(self):
        powershell = shutil.which('pwsh')
        git = shutil.which('git')
        if not powershell or not git:
            self.skipTest('PowerShell and Git are required for offline publisher validation')
        script_root = Path(__file__).parent
        for name in ('build-portable.py', 'publish-release.ps1'):
            self.write(self.repo / 'scripts' / name, (script_root / name).read_bytes())
        self.write(self.repo / 'releases/v1.0.5.md', b'Test release notes')
        for command in ([git, '-C', str(self.repo), 'init', '-b', 'main'], [git, '-C', str(self.repo), 'add', '--all'], [git, '-C', str(self.repo), '-c', 'user.name=Packaging test', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'test fixture']):
            subprocess.run(command, check=True, capture_output=True)
        archive = self.build()['archive']
        command = [powershell, '-NoProfile', '-NonInteractive', '-File', str(self.repo / 'scripts/publish-release.ps1'), '-Repository', 'example/CinderVault', '-Archive', archive, '-CreateRepository', '-ValidateOnly']
        result = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('1.0.5', result.stdout)
        remotes = subprocess.run([git, '-C', str(self.repo), 'remote'], capture_output=True, check=True)
        self.assertEqual(remotes.stdout.strip(), b'')
        self.write(self.repo / 'app/main.js', b'different source')
        rejected = subprocess.run(command, capture_output=True)
        self.assertNotEqual(rejected.returncode, 0)


if __name__ == '__main__':
    unittest.main()
