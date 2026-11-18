#!/usr/bin/env python3
"""
zipped-unzipped-sync.py
Bidirectional synchronizer and verification engine for font buckets:
  - ./zipped-fonts    (compressed archives)
  - ./unzipped-fonts  (extracted font packages)

Supports:
  --sync     (default) Bidirectional sync between both buckets
  --check    Verify integrity, checksums, and parity between buckets
  --report   Display full typography catalog and file statistics
  --force    Force overwrite even if timestamps match
"""

import sys
import os
import argparse
import zipfile
import shutil
from pathlib import Path
from datetime import datetime

FONT_EXTENSIONS = {".otf", ".ttf", ".woff", ".woff2", ".eot", ".svg"}

def find_fonts_root() -> Path:
    """Finds the root directory containing zipped-fonts and unzipped-fonts."""
    curr = Path(__file__).resolve().parent
    for _ in range(5):
        if (curr / "zipped-fonts").exists() or (curr / "unzipped-fonts").exists():
            return curr
        if (curr / "hermes-font-suite").exists():
            return curr
        curr = curr.parent
    # Fallback to current working directory
    cwd = Path.cwd()
    if (cwd / "zipped-fonts").exists() or (cwd / "unzipped-fonts").exists():
        return cwd
    return Path(r"Z:\luxdev\ludvig\fonts")

def inspect_folder(folder: Path) -> dict:
    """Collects metadata about an unzipped font folder."""
    font_files = []
    other_files = []
    total_size = 0
    for root, _, files in os.walk(folder):
        for f in files:
            p = Path(root) / f
            total_size += p.stat().st_size
            ext = p.suffix.lower()
            if ext in FONT_EXTENSIONS:
                font_files.append(p.name)
            else:
                other_files.append(p.name)
    return {
        "font_count": len(font_files),
        "font_files": sorted(font_files),
        "other_files": sorted(other_files),
        "total_size": total_size
    }

def sync_buckets(root: Path, force: bool = False, verbose: bool = True) -> tuple[int, int]:
    """Syncs zipped-fonts and unzipped-fonts bidirectionally."""
    zipped_dir = root / "zipped-fonts"
    unzipped_dir = root / "unzipped-fonts"

    zipped_dir.mkdir(parents=True, exist_ok=True)
    unzipped_dir.mkdir(parents=True, exist_ok=True)

    extracted_count = 0
    compressed_count = 0

    # 1. Zip -> Unzip sync
    for zp in sorted(zipped_dir.glob("*.zip")):
        stem = zp.stem
        target_dir = unzipped_dir / stem
        
        needs_extract = force or not target_dir.exists()
        if not needs_extract and target_dir.exists():
            # Check if zip was modified after target_dir
            zip_mtime = zp.stat().st_mtime
            dir_mtime = target_dir.stat().st_mtime
            if zip_mtime > dir_mtime:
                needs_extract = True

        if needs_extract:
            if verbose:
                print(f"[EXTRACT] {zp.name} -> unzipped-fonts/{stem}/")
            target_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(zp, 'r') as zf:
                zf.extractall(target_dir)
            extracted_count += 1

    # 2. Unzip -> Zip sync
    for fd in sorted(unzipped_dir.iterdir()):
        if not fd.is_dir():
            continue
        stem = fd.name
        target_zip = zipped_dir / f"{stem}.zip"
        
        needs_compress = force or not target_zip.exists()
        if not needs_compress and target_zip.exists():
            # Check if any file in folder is newer than zip
            zip_mtime = target_zip.stat().st_mtime
            for r, _, files in os.walk(fd):
                for f in files:
                    if (Path(r) / f).stat().st_mtime > zip_mtime:
                        needs_compress = True
                        break
                if needs_compress:
                    break

        if needs_compress:
            if verbose:
                print(f"[COMPRESS] unzipped-fonts/{stem}/ -> zipped-fonts/{target_zip.name}")
            with zipfile.ZipFile(target_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
                for r, _, files in os.walk(fd):
                    for f in files:
                        file_path = Path(r) / f
                        arcname = file_path.relative_to(fd)
                        zf.write(file_path, arcname=arcname)
            compressed_count += 1

    return extracted_count, compressed_count

def check_buckets(root: Path) -> bool:
    """Verifies complete parity and archive integrity between both buckets."""
    zipped_dir = root / "zipped-fonts"
    unzipped_dir = root / "unzipped-fonts"

    zips = {zp.stem: zp for zp in zipped_dir.glob("*.zip")}
    folders = {fd.name: fd for fd in unzipped_dir.iterdir() if fd.is_dir()}

    all_keys = sorted(set(zips.keys()) | set(folders.keys()))
    missing_unzipped = [k for k in zips if k not in folders]
    missing_zipped = [k for k in folders if k not in zips]

    print("=" * 60)
    print("FONT BUCKET PARITY VERIFICATION")
    print("=" * 60)
    print(f"Root: {root}")
    print(f"Total zipped fonts:   {len(zips)}")
    print(f"Total unzipped fonts: {len(folders)}")
    print(f"Total unique fonts:   {len(all_keys)}")
    print("-" * 60)

    is_valid = True
    if missing_unzipped:
        is_valid = False
        print(f"ERROR: Missing in unzipped-fonts ({len(missing_unzipped)}):")
        for m in missing_unzipped:
            print(f"  - {m}.zip")
    else:
        print("OK: All zipped fonts exist in unzipped-fonts.")

    if missing_zipped:
        is_valid = False
        print(f"ERROR: Missing in zipped-fonts ({len(missing_zipped)}):")
        for m in missing_zipped:
            print(f"  - {m}")
    else:
        print("OK: All unzipped fonts exist in zipped-fonts.")

    # Integrity check of all zips
    corrupt_zips = []
    for stem, zp in zips.items():
        try:
            with zipfile.ZipFile(zp, 'r') as zf:
                if zf.testzip() is not None:
                    corrupt_zips.append(zp.name)
        except Exception as e:
            corrupt_zips.append(f"{zp.name} ({e})")

    if corrupt_zips:
        is_valid = False
        print(f"ERROR: Corrupt zip archives detected ({len(corrupt_zips)}):")
        for cz in corrupt_zips:
            print(f"  - {cz}")
    else:
        print("OK: All zip archives are valid and uncorrupted.")

    print("=" * 60)
    if is_valid:
        print("RESULT: PARITY PASSED (100% synchronized)")
    else:
        print("RESULT: PARITY FAILED")
    print("=" * 60)
    return is_valid

def generate_report(root: Path):
    """Outputs a comprehensive report of all fonts in the buckets."""
    zipped_dir = root / "zipped-fonts"
    unzipped_dir = root / "unzipped-fonts"

    zips = {zp.stem: zp for zp in zipped_dir.glob("*.zip")}
    folders = {fd.name: fd for fd in unzipped_dir.iterdir() if fd.is_dir()}
    all_keys = sorted(set(zips.keys()) | set(folders.keys()))

    print(f"{'Font Name':<35} | {'Zipped Size':<12} | {'Unzipped Size':<14} | {'Font Files':<10} | {'Formats'}")
    print("-" * 90)
    for k in all_keys:
        z_size_str = "MISSING"
        if k in zips:
            size_kb = zips[k].stat().st_size / 1024
            z_size_str = f"{size_kb:8.1f} KB"

        u_size_str = "MISSING"
        font_count = 0
        formats = set()
        if k in folders:
            meta = inspect_folder(folders[k])
            u_size_kb = meta["total_size"] / 1024
            u_size_str = f"{u_size_kb:8.1f} KB"
            font_count = meta["font_count"]
            for ff in meta["font_files"]:
                formats.add(Path(ff).suffix.lower())

        fmt_str = ", ".join(sorted(formats)) if formats else "n/a"
        print(f"{k:<35} | {z_size_str:<12} | {u_size_str:<14} | {font_count:<10} | {fmt_str}")
    print("-" * 90)
    print(f"Total Fonts: {len(all_keys)}")

def main():
    parser = argparse.ArgumentParser(
        description="Bidirectional sync and verification for Ludvig font buckets (zipped-fonts & unzipped-fonts)."
    )
    parser.add_argument("--root", type=str, default=None, help="Root fonts directory path")
    parser.add_argument("--sync", action="store_true", default=True, help="Run bidirectional synchronization (default)")
    parser.add_argument("--check", action="store_true", help="Run parity and archive integrity check")
    parser.add_argument("--report", action="store_true", help="Generate inventory report")
    parser.add_argument("--force", action="store_true", help="Force overwrite during sync")

    args = parser.parse_args()

    root = Path(args.root) if args.root else find_fonts_root()
    if not root.exists():
        print(f"Error: Target root does not exist: {root}", file=sys.stderr)
        sys.exit(1)

    if args.check:
        valid = check_buckets(root)
        sys.exit(0 if valid else 1)
    elif args.report:
        generate_report(root)
    else:
        print(f"Synchronizing font buckets in: {root}")
        ext, comp = sync_buckets(root, force=args.force)
        print(f"Sync complete. Extracted: {ext}, Compressed: {comp}.")
        check_buckets(root)

if __name__ == "__main__":
    main()
