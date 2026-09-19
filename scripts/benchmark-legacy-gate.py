#!/usr/bin/env python3
"""Compare identical legacy tests against a Git baseline and the current tree.

Uses temporary source copies, shared installed dependencies, and the current
versions of the baseline's test files on both sides. Never switches the worktree.
This measures test-run wall time, not model performance or the full growing gate.
Run from the repository root: python3 scripts/benchmark-legacy-gate.py
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess
import tempfile
import time


def git(*args):
    return subprocess.check_output(["git", *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="f8bb28e")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--output", type=Path, default=Path("/tmp/casper-legacy-gate.json"))
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    baseline = git("rev-parse", "--verify", args.baseline + "^{commit}").decode().strip()
    files = [name for name in git("ls-tree", "-r", "--name-only", baseline, "tests").decode().splitlines()
             if name.endswith(".test.ts")]
    if not files:
        parser.error("baseline contains no tests")
    result = {
        "baseline": baseline,
        "environment": {"platform": platform.platform(), "bun": subprocess.check_output(["bun", "--version"]).decode().strip()},
        "method": "Identical current legacy test files; shared current node_modules; alternating baseline/current; wall time excludes source setup; no typecheck.",
        "testHashes": {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files},
        "sourceHashes": {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest()
                         for file in sorted((root / "src").rglob("*")) if file.is_file()},
        "lockHash": hashlib.sha256((root / "bun.lock").read_bytes()).hexdigest(),
        "samples": [],
    }
    with tempfile.TemporaryDirectory(prefix="casper-legacy-gate-") as directory:
        previous = Path(directory)
        subprocess.run(["tar", "-x", "-C", directory], input=git("archive", baseline), check=True)
        (previous / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
        for name in files:
            (previous / name).write_bytes((root / name).read_bytes())
        for index in range(args.runs):
            for label, cwd in [("baseline", previous), ("current", root)]:
                start = time.monotonic()
                run = subprocess.run(["bun", "test", *["./" + name for name in files]], cwd=cwd, capture_output=True, text=True)
                sample = {"revision": label, "run": index + 1, "seconds": round(time.monotonic() - start, 3), "exitCode": run.returncode}
                print(json.dumps(sample), flush=True)
                result["samples"].append(sample)
                if run.returncode:
                    raise RuntimeError("Benchmark validation failed; timing is not comparable. Run the selected tests directly for diagnostics.")
    result["medianSeconds"] = {label: statistics.median(sample["seconds"] for sample in result["samples"] if sample["revision"] == label)
                               for label in ["baseline", "current"]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["medianSeconds"]))


if __name__ == "__main__":
    main()
