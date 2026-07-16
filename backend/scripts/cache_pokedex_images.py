from __future__ import annotations

import argparse
import json

from services.pokedex_images import MAX_DEX_ID, populate_cache


def main() -> int:
    parser = argparse.ArgumentParser(description="Populate the persistent National Pokédex image cache")
    parser.add_argument("--min", dest="minimum", type=int, default=1)
    parser.add_argument("--max", dest="maximum", type=int, default=MAX_DEX_ID)
    parser.add_argument("--refresh", action="store_true", help="replace existing cached files")
    parser.add_argument("--missing-only", action="store_true", help="compatibility flag; this is the default")
    parser.add_argument("--delay", type=float, default=0.05)
    args = parser.parse_args()
    result = populate_cache(
        minimum=args.minimum,
        maximum=args.maximum,
        refresh=args.refresh,
        delay=max(args.delay, 0),
    )
    print(json.dumps(result, indent=2))
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
