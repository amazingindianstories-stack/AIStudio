#!/usr/bin/env python3
"""
Packages the project into a clean, self-contained zip archive near 10 MB.
Includes all git-tracked source files, local configs/env examples, tests,
documentation, and screenshots, while excluding node_modules, build outputs,
large venvs, and raw multi-megabyte media binaries.
"""

import os
import shutil
import subprocess
import zipfile

def package_project():
    # 1. Git-tracked files
    git_files = subprocess.check_output(["git", "ls-files"]).decode().splitlines()

    # 2. Untracked files (new code, screenshots, configs)
    untracked_raw = subprocess.check_output(["git", "status", "--porcelain"]).decode().splitlines()
    untracked = []
    for line in untracked_raw:
        if line.startswith("?? "):
            p = line[3:].strip().strip('"')
            if os.path.isdir(p):
                for root, _, files in os.walk(p):
                    for f in files:
                        untracked.append(os.path.relpath(os.path.join(root, f), "."))
            elif os.path.isfile(p):
                untracked.append(p)

    # 3. Known essential local data files and example templates (NO LIVE SECRETS)
    extra = [
        ".env.local.example",
        "data/assets.json",
        "data/history.json",
        "data/projects.json",
        "data/seedance-task-list-raw.json",
        "public/mag_key.png",
    ]

    combined = set(git_files) | set(untracked) | set(extra)

    exclude_prefixes = (
        "node_modules/",
        ".next/",
        ".git/",
        "depth-worker/.venv/",
        "pyserver/.venv/",
        "pyserver/models/",
        "backend/venv/",
        ".vercel/",
        "playwright-report/",
        "test-results/",
        "public/media/",
        "public/generations/",
        "public/references/",
    )

    def should_keep(f):
        if not os.path.exists(f) or os.path.isdir(f):
            return False
        if f.endswith(".zip"):
            return False
        if "__pycache__" in f or f.endswith(".pyc") or ".DS_Store" in f or "debug.png" in f:
            return False

        # CRITICAL SECURITY EXCLUSIONS: Never package live environment files, secrets, or worker credentials
        base = os.path.basename(f)
        if base.startswith(".env") and not (base.endswith(".example") or base.endswith(".sample")):
            return False
        if ".env" in f and not (f.endswith(".example") or f.endswith(".sample")):
            return False
        if base in (".worker-id", ".higgsfield-mcp-token.json"):
            return False
        if base.endswith(".pem") or base.endswith(".key") or base.endswith(".credentials"):
            return False

        for pfx in exclude_prefixes:
            if f.startswith(pfx) and not f.endswith(".gitkeep"):
                return False
        # Filter raw council media binaries > 1MB
        if f.startswith(".council/"):
            if os.path.getsize(f) > 1_000_000:
                return False
        return True

    clean_files = [f for f in sorted(combined) if should_keep(f)]

    zip_name = "image-video-project.zip"
    if os.path.exists(zip_name):
        os.remove(zip_name)

    print(f"Creating {zip_name} with {len(clean_files)} files...")
    with zipfile.ZipFile(zip_name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in clean_files:
            zf.write(f)

    # Security verification: ensure zero secrets were packaged
    with zipfile.ZipFile(zip_name, "r") as zf:
        forbidden = []
        for name in zf.namelist():
            base = os.path.basename(name)
            if (".env" in name and not (name.endswith(".example") or name.endswith(".sample"))) or base in (".worker-id", ".higgsfield-mcp-token.json"):
                forbidden.append(name)
        if forbidden:
            os.remove(zip_name)
            raise RuntimeError(f"SECURITY AUDIT FAILED: Archive contains forbidden credential files: {forbidden}")
        print("Security audit passed: 0 credentials or live env files in archive.")

    sz_mb = os.path.getsize(zip_name) / (1024 * 1024)
    print(f"Archive created: {zip_name} ({sz_mb:.2f} MB)")

    # Also update parent directory archive
    parent_zip = "../image-video-project.zip"
    shutil.copy2(zip_name, parent_zip)
    print(f"Copied archive to: {parent_zip}")

if __name__ == "__main__":
    package_project()
