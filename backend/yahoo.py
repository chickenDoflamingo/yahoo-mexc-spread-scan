from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

logger = logging.getLogger(__name__)

US_MARKET_TZ = ZoneInfo("America/New_York")
DOWNLOAD_BATCH_SIZE = 12
MAX_METADATA_UPDATES_PER_CYCLE = 8
US_EXCHANGE_HINTS = {
    "NAS",
    "NMS",
    "NGM",
    "NCM",
    "NYQ",
    "NYS",
    "NYSE",
    "NASDAQ",
    "AMEX",
    "ASE",
    "ARCA",
    "BATS",
    "IEX",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_symbol(symbol: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", symbol.upper())


def _coerce_float(value: Any) -> float | None:
    if value in (None, "", "nan"):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(number):
        return None
    return number


def _fast_info_to_dict(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return dict(raw)

    data: dict[str, Any] = {}
    for key in ("lastPrice", "previousClose", "currency", "timezone"):
        try:
            data[key] = raw[key]
            continue
        except Exception:
            pass
        try:
            data[key] = getattr(raw, key)
        except Exception:
            continue
    return data


def _timestamp_to_iso(timestamp: Any) -> str | None:
    if timestamp is None:
        return None
    try:
        ts = pd.Timestamp(timestamp)
    except Exception:
        return None
    if ts.tzinfo is None:
        ts = ts.tz_localize(timezone.utc)
    return ts.tz_convert(timezone.utc).isoformat()


def _is_after_hours(timestamp: Any) -> bool:
    try:
        ts = pd.Timestamp(timestamp)
    except Exception:
        return False
    if ts.tzinfo is None:
        ts = ts.tz_localize(US_MARKET_TZ)
    local = ts.tz_convert(US_MARKET_TZ)
    minutes = local.hour * 60 + local.minute
    market_open = 9 * 60 + 30
    market_close = 16 * 60
    return local.weekday() >= 5 or minutes < market_open or minutes >= market_close


def _series_to_latest_point(series: pd.Series) -> dict[str, Any] | None:
    cleaned = series.dropna()
    if cleaned.empty:
        return None
    last_timestamp = cleaned.index[-1]
    price = _coerce_float(cleaned.iloc[-1])
    if price is None:
        return None
    return {
        "current_price": price,
        "price_timestamp": _timestamp_to_iso(last_timestamp),
        "observed_after_hours": _is_after_hours(last_timestamp),
    }


def _is_us_equity(payload: dict[str, Any], expected: str) -> bool:
    quote_type = str(
        payload.get("quoteType")
        or payload.get("type")
        or payload.get("typeDisp")
        or ""
    ).upper()
    if quote_type and "EQUITY" not in quote_type and quote_type != "STOCK":
        return False

    symbol = str(payload.get("symbol") or payload.get("ticker") or "").upper()
    if symbol and _normalize_symbol(symbol) != expected:
        return False

    exchange = str(
        payload.get("exchange")
        or payload.get("exchDisp")
        or payload.get("fullExchangeName")
        or ""
    ).upper()
    region = str(payload.get("region") or "").upper()
    if region == "US":
        return True
    return any(hint in exchange for hint in US_EXCHANGE_HINTS)


def _batched(items: Iterable[str], batch_size: int) -> list[list[str]]:
    values = list(items)
    return [values[index : index + batch_size] for index in range(0, len(values), batch_size)]


class YahooClient:
    def __init__(self) -> None:
        self._quote_cache: dict[str, dict[str, Any]] = {}
        self._lookup_cache: dict[str, str | None] = {}
        self._metadata_refreshed_at: dict[str, datetime] = {}

    def get_cached_price(self, symbol: str) -> dict[str, Any] | None:
        return self._quote_cache.get(symbol.upper())

    def _metadata_is_stale(self, symbol: str) -> bool:
        refreshed_at = self._metadata_refreshed_at.get(symbol)
        if refreshed_at is None:
            return True
        return _utcnow() - refreshed_at >= timedelta(minutes=10)

    def _extract_close_series(self, frame: pd.DataFrame, symbol: str) -> pd.Series | None:
        if frame.empty:
            return None
        if not isinstance(frame.columns, pd.MultiIndex):
            if "Close" in frame.columns:
                return frame["Close"]
            return None

        level_zero = frame.columns.get_level_values(0)
        level_one = frame.columns.get_level_values(1)

        if symbol in level_zero:
            subframe = frame[symbol]
            if "Close" in subframe.columns:
                return subframe["Close"]
        if symbol in level_one:
            try:
                subframe = frame.xs(symbol, axis=1, level=1)
            except KeyError:
                return None
            if "Close" in subframe.columns:
                return subframe["Close"]
        return None

    def _download_prices_sync(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        latest_points: dict[str, dict[str, Any]] = {}
        for batch in _batched(symbols, DOWNLOAD_BATCH_SIZE):
            if not batch:
                continue

            frame = yf.download(
                tickers=" ".join(batch),
                period="2d",
                interval="1m",
                group_by="ticker",
                auto_adjust=False,
                prepost=True,
                progress=False,
                threads=True,
            )
            if frame.empty:
                continue

            if len(batch) == 1:
                close_series = frame["Close"] if "Close" in frame.columns else None
                if close_series is not None:
                    latest_point = _series_to_latest_point(close_series)
                    if latest_point:
                        latest_points[batch[0]] = latest_point
                continue

            for symbol in batch:
                close_series = self._extract_close_series(frame, symbol)
                if close_series is None:
                    continue
                latest_point = _series_to_latest_point(close_series)
                if latest_point:
                    latest_points[symbol] = latest_point

        return latest_points

    def _fetch_single_metadata_sync(self, symbol: str) -> dict[str, Any]:
        ticker = yf.Ticker(symbol)
        fast_info = {}
        info = {}

        try:
            fast_info = _fast_info_to_dict(ticker.fast_info)
        except Exception as exc:
            logger.debug("fast_info failed for %s: %s", symbol, exc)

        try:
            info = ticker.info or {}
        except Exception as exc:
            logger.debug("info failed for %s: %s", symbol, exc)

        previous_close = (
            _coerce_float(info.get("previousClose"))
            or _coerce_float(info.get("regularMarketPreviousClose"))
            or _coerce_float(fast_info.get("previousClose"))
        )
        current_price = (
            _coerce_float(info.get("currentPrice"))
            or _coerce_float(info.get("regularMarketPrice"))
            or _coerce_float(fast_info.get("lastPrice"))
        )
        after_hours_price = _coerce_float(info.get("postMarketPrice"))

        if previous_close is None:
            try:
                history = ticker.history(period="5d", interval="1d", auto_adjust=False)
            except Exception as exc:
                logger.debug("history failed for %s: %s", symbol, exc)
                history = pd.DataFrame()
            if not history.empty and "Close" in history.columns:
                close_series = history["Close"].dropna()
                if not close_series.empty:
                    previous_close = _coerce_float(close_series.iloc[-1])

        return {
            "symbol": symbol,
            "current_price": current_price,
            "after_hours_price": after_hours_price,
            "previous_close": previous_close,
            "currency": info.get("currency") or fast_info.get("currency") or "USD",
            "exchange": info.get("exchange") or info.get("fullExchangeName"),
            "quote_type": info.get("quoteType"),
            "updated_at": _utcnow().isoformat(),
        }

    def _pick_lookup_result(self, candidate: str, results: list[dict[str, Any]]) -> str | None:
        normalized = _normalize_symbol(candidate)
        ranked: list[tuple[int, str]] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            symbol = str(item.get("symbol") or item.get("ticker") or "").upper()
            if not symbol or _normalize_symbol(symbol) != normalized:
                continue
            if not _is_us_equity(item, normalized):
                continue

            score = 0
            if symbol == candidate:
                score += 3
            region = str(item.get("region") or "").upper()
            exchange = str(
                item.get("exchange")
                or item.get("exchDisp")
                or item.get("fullExchangeName")
                or ""
            ).upper()
            if region == "US":
                score += 2
            if any(hint in exchange for hint in US_EXCHANGE_HINTS):
                score += 2
            ranked.append((score, symbol))

        if not ranked:
            return None

        ranked.sort(key=lambda item: (-item[0], item[1]))
        return ranked[0][1]

    def _resolve_symbol_sync(self, candidate: str) -> str | None:
        candidate = candidate.upper().strip()
        normalized = _normalize_symbol(candidate)
        lookup_cls = getattr(yf, "Lookup", None)

        if lookup_cls is not None:
            try:
                lookup = lookup_cls(candidate, timeout=10, raise_errors=False)
                results = list(getattr(lookup, "stock", []) or [])
                resolved = self._pick_lookup_result(candidate, results)
                if resolved:
                    return resolved
            except Exception as exc:
                logger.debug("Lookup failed for %s: %s", candidate, exc)

        try:
            ticker = yf.Ticker(candidate)
            info = ticker.info or {}
        except Exception as exc:
            logger.debug("Ticker fallback failed for %s: %s", candidate, exc)
            return None

        if _is_us_equity(info, normalized):
            return str(info.get("symbol") or candidate).upper()
        return None

    async def resolve_symbol(self, candidate: str) -> str | None:
        normalized = _normalize_symbol(candidate)
        if normalized in self._lookup_cache:
            return self._lookup_cache[normalized]

        resolved = await asyncio.to_thread(self._resolve_symbol_sync, candidate)
        self._lookup_cache[normalized] = resolved
        return resolved

    async def refresh_prices(
        self,
        symbols: Iterable[str],
        force_metadata: bool = False,
    ) -> dict[str, dict[str, Any]]:
        symbols = sorted({symbol.upper() for symbol in symbols if symbol})
        if not symbols:
            return {}

        try:
            latest_points = await asyncio.to_thread(self._download_prices_sync, symbols)
        except Exception as exc:
            logger.warning("Yahoo batch download failed: %s", exc)
            latest_points = {}

        for symbol, point in latest_points.items():
            cached = dict(self._quote_cache.get(symbol, {}))
            cached.update(point)
            cached["symbol"] = symbol
            cached["updated_at"] = _utcnow().isoformat()
            if point.get("observed_after_hours"):
                cached["after_hours_price"] = point.get("current_price")
            self._quote_cache[symbol] = cached

        metadata_targets: list[str] = []
        if force_metadata:
            metadata_targets = [
                symbol
                for symbol in symbols
                if self._metadata_is_stale(symbol) or symbol not in self._quote_cache
            ][:MAX_METADATA_UPDATES_PER_CYCLE]

        if metadata_targets:
            semaphore = asyncio.Semaphore(6)

            async def load_metadata(symbol: str) -> tuple[str, dict[str, Any]]:
                async with semaphore:
                    try:
                        return symbol, await asyncio.to_thread(
                            self._fetch_single_metadata_sync,
                            symbol,
                        )
                    except Exception as exc:
                        logger.warning("Yahoo metadata refresh failed for %s: %s", symbol, exc)
                        return symbol, {}

            results = await asyncio.gather(
                *(load_metadata(symbol) for symbol in metadata_targets)
            )
            for symbol, metadata in results:
                if not metadata:
                    continue
                cached = dict(self._quote_cache.get(symbol, {}))
                cached.update({key: value for key, value in metadata.items() if value is not None})
                cached["symbol"] = symbol
                cached["updated_at"] = _utcnow().isoformat()
                self._quote_cache[symbol] = cached
                self._metadata_refreshed_at[symbol] = _utcnow()

        return {
            symbol: dict(self._quote_cache[symbol])
            for symbol in symbols
            if symbol in self._quote_cache
        }

    async def get_price(self, symbol: str) -> dict[str, Any] | None:
        symbol = symbol.upper().strip()
        await self.refresh_prices([symbol], force_metadata=True)
        return self.get_cached_price(symbol)


_default_client: YahooClient | None = None


def get_default_client() -> YahooClient:
    global _default_client
    if _default_client is None:
        _default_client = YahooClient()
    return _default_client


async def get_price(symbol: str) -> dict[str, Any] | None:
    return await get_default_client().get_price(symbol)
