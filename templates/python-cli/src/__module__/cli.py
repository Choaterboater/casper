"""The {{name}} command line. Standard library only."""

from __future__ import annotations

import argparse
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="{{name}}", description="A command-line tool.")
    commands = parser.add_subparsers(dest="command", required=True)
    hello = commands.add_parser("hello", help="say hello")
    hello.add_argument("--who", default="world", help="who to greet (default: world)")
    return parser


def greeting(who: str) -> str:
    return f"Hello, {who}!"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "hello":
        print(greeting(args.who))
        return 0
    return 2  # argparse rejects unknown commands before this line


if __name__ == "__main__":
    sys.exit(main())
