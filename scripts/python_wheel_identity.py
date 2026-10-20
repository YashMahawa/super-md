#!/usr/bin/env python3
"""Print the stable runtime/requirements key used for the Python wheel cache."""
import argparse
from pathlib import Path

from prepare_python_wheelhouse import cache_identity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("requirements", nargs="+", type=Path)
    args = parser.parse_args()
    print(cache_identity(args.requirements))


if __name__ == "__main__":
    main()
