from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MexcApiError(RuntimeError):
    """Raised when the public MEXC API returns an invalid response."""


class MexcClient:
    BASE_URL = "https://contract.mexc.com/api/v1/contract/"

    def __init__(self, timeout: float = 10.0) -> None:
        self._client = httpx.AsyncClient(
            base_url=self.BASE_URL,
            timeout=timeout,
            headers={"User-Agent": "spread-monitor/1.0"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def _get_json(
        self,
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = await self._client.get(path.lstrip("/"), params=params)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise MexcApiError(f"Unexpected payload for {path}: {type(payload)!r}")
        if payload.get("success") is False:
            raise MexcApiError(
                f"MEXC returned an error for {path}: {payload.get('code')}"
            )
        return payload

    @staticmethod
    def _coerce_items(raw: Any) -> list[dict[str, Any]]:
        if isinstance(raw, list):
            return [item for item in raw if isinstance(item, dict)]
        if isinstance(raw, dict):
            return [raw]
        return []

    async def get_all_symbols(self) -> list[dict[str, Any]]:
        """Return active USDT contracts enriched with the latest ticker snapshot."""

        details_json, tickers_json = await self._get_json("/detail"), await self._get_json("/ticker")

        details = self._coerce_items(details_json.get("data"))
        tickers = self._coerce_items(tickers_json.get("data"))
        tickers_by_symbol = {
            item["symbol"]: item
            for item in tickers
            if isinstance(item, dict) and item.get("symbol")
        }

        contracts: list[dict[str, Any]] = []
        for contract in details:
            symbol = contract.get("symbol")
            if not symbol:
                continue
            if contract.get("quoteCoin") != "USDT":
                continue
            if int(contract.get("state", 1)) != 0:
                continue
            if contract.get("isHidden"):
                continue

            merged = dict(contract)
            merged.update(tickers_by_symbol.get(symbol, {}))
            contracts.append(merged)

        logger.debug("Loaded %s active MEXC USDT contracts", len(contracts))
        return contracts

    async def get_price(self, symbol: str) -> dict[str, Any] | None:
        payload = await self._get_json("/ticker", params={"symbol": symbol})
        data = payload.get("data")
        if isinstance(data, list):
            data = next((item for item in data if item.get("symbol") == symbol), None)
        if not isinstance(data, dict):
            return None
        return {
            "symbol": data.get("symbol"),
            "last_price": data.get("lastPrice"),
            "mark_price": data.get("fairPrice"),
            "funding_rate": data.get("fundingRate"),
            "timestamp": data.get("timestamp"),
        }
