#!/usr/bin/env python3
"""One-shot DDGS image search helper for qq-cli-bridge.

Stdout: JSON {"ok": true, "results": [...]} or {"ok": false, "error": "..."}.
No secrets; free DuckDuckGo image search via the maintained `ddgs` package.

JSON is always ASCII-escaped so Windows consoles (cp936/gbk) never raise
UnicodeEncodeError when titles contain Hangul, kana, or emoji — that crash was
swallowing all candidates for artists like Chaewon / Iroha in the Bridge.
"""
from __future__ import annotations

import argparse
import json
import sys


def _emit(payload: dict) -> None:
    # ensure_ascii=True → \uXXXX escapes; safe on any stdout encoding.
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> int:
    # Prefer UTF-8 when the parent (Node) set PYTHONIOENCODING / PYTHONUTF8.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser(description="DDGS image search for qq-cli-bridge")
    parser.add_argument("--query", required=True)
    parser.add_argument("--max", type=int, default=12)
    args = parser.parse_args()
    query = (args.query or "").strip()
    if not query:
        _emit({"ok": False, "error": "empty query"})
        return 1
    limit = max(1, min(int(args.max or 12), 40))
    try:
        from ddgs import DDGS  # type: ignore
    except Exception as exc:  # noqa: BLE001
        _emit(
            {
                "ok": False,
                "error": f"ddgs package missing: {exc}. Install with: pip install ddgs",
            }
        )
        return 2
    try:
        raw = list(DDGS().images(query, max_results=limit))
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": str(exc)})
        return 3
    results = []
    for item in raw:
        image = (item.get("image") or "").strip()
        if not image.startswith("http"):
            continue
        results.append(
            {
                "title": item.get("title") or "",
                "image": image,
                "thumbnail": item.get("thumbnail") or "",
                "url": item.get("url") or "",
                "width": item.get("width"),
                "height": item.get("height"),
                "source": item.get("source") or "",
            }
        )
    _emit({"ok": True, "results": results})
    return 0


if __name__ == "__main__":
    sys.exit(main())
