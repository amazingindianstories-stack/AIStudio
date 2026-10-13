"""Disposable local qualification; no checkout env or credential files are loaded."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
ROOT_FILES = {'package.json', 'package-lock.json', 'jsconfig.json', 'next.config.js',
              'eslint.config.mjs', 'playwright.config.mjs',
              'postcss.config.js', 'tailwind.config.js', 'vercel.json', 'AGENTS.md',
              'CLAUDE.md', 'DEPLOYMENT_RUNBOOK.md', 'BACKEND_AUDIT.md', 'progress.md', '.gitignore',
              'public/logo.png', 'Dockerfile.worker', 'Dockerfile.worker.dockerignore',
              'railway.toml'}
DIRECTORIES = {'src', 'scripts', 'tests', 'backend', 'docs', '.github', 'infra'}
DOCUMENT_SOURCE_SUFFIXES = {'.md', '.json', '.yaml', '.yml', '.txt', '.py', '.mjs', '.js', '.sql', '.sh', '.toml'}


def copy_source_path(path):
    """Copy source contracts, never prior browser archives/runtime recordings.

    Raw traces remain at their original evidence paths. They are not inputs to
    qualification, and copying/indexing gigabytes of them obscures source identity.
    """
    if not path.parts or (path.parts[0] not in DIRECTORIES and str(path) not in ROOT_FILES):
        return False
    if any(part.startswith('.env') or part in {'__pycache__', '.venv', 'venv', 'node_modules', 'screenshots', 'support', 'test-results', 'playwright-report'} for part in path.parts):
        return False
    if path.suffix in {'.zip', '.zip.tmp', '.pyc', '.pem', '.key'}:
        return False
    if path.parts[0] == 'docs' and path.suffix not in DOCUMENT_SOURCE_SUFFIXES:
        return False
    return True


def refresh(session):
    target = session / 'repo'
    copied = []
    files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    for name in files:
        p = Path(name)
        if not name or not copy_source_path(p):
            continue
        source = ROOT / p
        if not source.is_file() or source.is_symlink():
            continue
        dest = target / p
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        copied.append(str(p))
    # Remove only previously copied source files that disappeared or became
    # excluded. Otherwise renames leave two migration graphs in the test image.
    if (target / '.git').exists():
        previous = subprocess.check_output(['git', 'ls-files', '-z'], cwd=target).decode().split('\0')
        for name in set(previous) - set(copied) - {''}:
            stale = target / name
            if not stale.parent.resolve().is_relative_to(target.resolve()):
                raise SystemExit('Copied source path escapes isolated checkout')
            if stale.is_file() or stale.is_symlink():
                stale.unlink()
        for directory in sorted((p for p in target.rglob('*') if p.is_dir() and '.git' not in p.parts and 'node_modules' not in p.parts), key=lambda p: len(p.parts), reverse=True):
            try:
                directory.rmdir()
            except OSError:
                pass
    # npm ci follows/removes an inherited node_modules symlink's contents.
    # Qualification must install its own dependencies, never mutate checkout
    # dependencies through a shared link.
    modules = target / 'node_modules'
    if modules.is_symlink():
        modules.unlink()
    # Independent local metadata lets packaging/documentation tests inspect the
    # copied source without sharing or touching the user's Git index.
    git_env = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(session / 'home')}
    if not (target / '.git').exists():
        subprocess.run(['git', 'init', '--quiet'], cwd=target, env=git_env, check=True)
    subprocess.run(['git', 'add', '-u'], cwd=target, env=git_env, check=True)
    subprocess.run(['git', 'add', '--force', '--', *copied], cwd=target, env=git_env, check=True)
    return target


def environment(session, port):
    # Child HOME is isolated; the user's HOME and credential files are unchanged.
    # No inherited provider/cloud credentials, preload hooks, proxy or DB settings.
    return {
        'PATH': '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'HOME': str(session / 'home'), 'TMPDIR': str(session / 'tmp'),
        'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8',
        'DATABASE_BACKEND': 'postgres',
        'DATABASE_URL': f'postgresql://migration@127.0.0.1:{port}/veevee_django_migration',
        'AUTH_SECRET': 'disposable-migration-cookie-secret',
        'DJANGO_SECRET_KEY': 'disposable-django-framework-secret',
        'DJANGO_SETTINGS_MODULE': 'config.settings.test',
        'MIGRATION_TEST_ISOLATED': '1', 'DJANGO_ALLOWED_HOSTS': '127.0.0.1,localhost,testserver',
        'MOCK_GENERATION': '1', 'MOCK_ASSET_PROVIDER': '1',
        'AWS_EC2_METADATA_DISABLED': 'true', 'NEXT_TELEMETRY_DISABLED': '1',
        'ENV_FILE': str(session / 'empty.env'), 'CI': '1',
        'VEEVEE_SOURCE_REVISION': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
    }


def main():
    mode = sys.argv[1]
    if mode == 'prepare':
        session = Path(tempfile.mkdtemp(prefix='veevee-django-', dir='/private/tmp'))
        for folder in ('home', 'tmp', 'repo'):
            (session / folder).mkdir()
        (session / 'empty.env').touch()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        (session / 'isolation.json').write_text(json.dumps({'purpose': 'veevee-django-disposable', 'source': str(ROOT), 'port': port}))
        refresh(session)
        print(session)
        return
    session = Path(sys.argv[2]).resolve()
    if session.parent != Path('/private/tmp') or not session.name.startswith('veevee-django-'):
        raise SystemExit('Refusing non-disposable session path')
    marker = json.loads((session / 'isolation.json').read_text())
    if marker['purpose'] != 'veevee-django-disposable' or marker['source'] != str(ROOT):
        raise SystemExit('Isolation marker mismatch')
    port = marker['port']
    target = refresh(session)
    env = environment(session, port)
    if mode == 'start-db':
        if (session / 'pgdata').exists():
            raise SystemExit('Cluster already exists; inspect its status instead of restarting it')
        subprocess.run(['initdb', '-D', str(session / 'pgdata'), '-U', 'migration', '-A', 'trust', '--no-locale', '--encoding=UTF8'], env=env, check=True)
        subprocess.run(['pg_ctl', '-D', str(session / 'pgdata'), '-l', str(session / 'postgres.log'), '-o', f'-h 127.0.0.1 -p {port} -k {session / "tmp"}', '-w', 'start'], env=env, check=True)
        subprocess.run(['createdb', '-h', '127.0.0.1', '-p', str(port), '-U', 'migration', 'veevee_django_migration'], env=env, check=True)
        return
    # Fail closed before any test, Django command or database utility.
    pid = (session / 'pgdata' / 'postmaster.pid').read_text().splitlines()
    if Path(pid[1]).resolve() != session / 'pgdata' or int(pid[3]) != port:
        raise SystemExit('Cluster identity mismatch')
    subprocess.run(['pg_ctl', '-D', str(session / 'pgdata'), 'status'], env=env, check=True, stdout=subprocess.DEVNULL)
    command = sys.argv[3:]
    if mode == 'stop-db':
        command = ['pg_ctl', '-D', str(session / 'pgdata'), '-m', 'fast', '-w', 'stop']
    elif mode != 'run' or not command:
        raise SystemExit('Usage: prepare | start-db SESSION | run SESSION COMMAND ... | stop-db SESSION')
    print('Isolation verified: copied source; empty credential home; allowlisted env; live dedicated loopback cluster.', flush=True)
    raise SystemExit(subprocess.call(command, cwd=target, env=env))


if __name__ == '__main__':
    main()
