#!/usr/bin/env python3
"""Keep only the newest N scheduled local backup sets. S3 is the primary copy.

Plan by default; --apply deletes. Only directories named scheduled-<timestamp>-<id> directly
under the backups directory are candidates; named sets (e.g. 20260911-first-production)
are never touched. Added 2026-10-20 after the local copies reached 53 GB / 41 sets.
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

DEFAULT_ROOT = Path.home() / ".local/state/sagerock-recovery/backups"
PATTERN = re.compile(r"^scheduled-\d{8}T\d{6}Z-[0-9a-f]{8}$")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--keep", type=int, default=14)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if args.keep < 1:
        sys.exit("--keep must be at least 1")
    sets = sorted((p for p in root.iterdir() if p.is_dir() and PATTERN.match(p.name)), key=lambda p: p.name, reverse=True)
    doomed = sets[args.keep:]
    print(f"{len(sets)} scheduled sets under {root}; keeping newest {args.keep}; {len(doomed)} to remove")
    for p in doomed:
        print(("removing " if args.apply else "would remove ") + p.name)
        if args.apply:
            shutil.rmtree(p)
    if not args.apply and doomed:
        print("Plan only. Re-run with --apply to delete.")


if __name__ == "__main__":
    main()
