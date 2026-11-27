from __future__ import annotations

import argparse
import asyncio
import sys

from .demo import format_report, run_demo


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="replyonce", description="replyonce command line")
    sub = parser.add_subparsers(dest="command")
    demo = sub.add_parser("demo", help="chaos simulation of a support agent with and without replyonce")
    demo.add_argument("--conversations", type=int, default=100)
    demo.add_argument("--seed", type=int, default=7)
    args = parser.parse_args(argv)
    if args.command != "demo":
        parser.print_help()
        return 0 if args.command is None else 1
    if args.conversations <= 0:
        parser.error("--conversations must be positive")
    without, with_ = asyncio.run(run_demo(args.conversations, args.seed))
    print(format_report(without, with_))
    return 0 if with_.duplicate_answers == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
