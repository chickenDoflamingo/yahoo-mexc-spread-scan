from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

from backend.main import SpreadMonitor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("push-remote-snapshot")

REMOTE_BASE_URL = os.getenv("REMOTE_BASE_URL", "").rstrip("/")
PUBLIC_INGEST_TOKEN = os.getenv("PUBLIC_INGEST_TOKEN", "")
PUSH_INTERVAL_SECONDS = float(os.getenv("PUSH_INTERVAL_SECONDS", "3"))
REQUEST_TIMEOUT_SECONDS = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "20"))


def _validate_env() -> None:
    if not REMOTE_BASE_URL:
        raise RuntimeError("REMOTE_BASE_URL is required")
    if not PUBLIC_INGEST_TOKEN:
        raise RuntimeError("PUBLIC_INGEST_TOKEN is required")


async def _push_payload(
    client: httpx.AsyncClient,
    payload: dict[str, Any],
) -> None:
    response = await client.post(
        f"{REMOTE_BASE_URL}/api/ingest/snapshot",
        json=payload,
        headers={"X-Ingest-Token": PUBLIC_INGEST_TOKEN},
    )
    response.raise_for_status()


async def main() -> None:
    _validate_env()

    collector = SpreadMonitor()
    await collector.storage.initialize()

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        try:
            while True:
                started = asyncio.get_running_loop().time()
                try:
                    await collector.refresh_once()
                    payload = await collector.snapshot_payload(
                        min_spread_pct=0.0,
                        max_spread_pct=10_000.0,
                        search="",
                        sort_by="spread_desc",
                    )
                    await _push_payload(client, payload)
                    logger.info(
                        "Pushed %s rows to %s",
                        len(payload.get("rows") or []),
                        REMOTE_BASE_URL,
                    )
                except Exception as exc:
                    logger.warning("Push cycle failed: %s", exc)

                elapsed = asyncio.get_running_loop().time() - started
                await asyncio.sleep(max(0.5, PUSH_INTERVAL_SECONDS - elapsed))
        finally:
            await collector.mexc.close()


if __name__ == "__main__":
    asyncio.run(main())
