from __future__ import annotations

import logging
import re
from typing import Any

from .yahoo import YahooClient

logger = logging.getLogger(__name__)

DISPLAY_SYMBOL_RE = re.compile(r"([A-Z0-9.\-]{1,10})_USDT")
SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,9}$")
EXCLUDED_NON_EQUITY_TICKERS = {"QQQ", "EWJ", "EWY", "SPY", "DIA", "IWM"}
EXCLUDED_ANOMALOUS_TICKERS = {"NOW", "NFLX"}


def _clean_candidate(raw: str | None) -> str | None:
    if not raw:
        return None
    candidate = raw.upper().strip().replace("/", "")
    candidate = candidate.removesuffix("STOCK")
    candidate = candidate.removesuffix("SHARES")
    candidate = candidate.removesuffix("BASE")
    if not candidate or not SYMBOL_RE.fullmatch(candidate):
        return None
    return candidate


def _extract_candidates(contract: dict[str, Any]) -> list[str]:
    candidates: list[str] = []

    for field_name in ("displayNameEn", "displayName"):
        raw = str(contract.get(field_name) or "").upper()
        match = DISPLAY_SYMBOL_RE.search(raw)
        if not match:
            continue
        candidate = _clean_candidate(match.group(1))
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    symbol = str(contract.get("symbol") or "").upper().strip()
    base_coin = str(contract.get("baseCoin") or "").upper().strip()
    for raw in (base_coin, symbol.split("_")[0]):
        candidate = _clean_candidate(raw)
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    return candidates


def _looks_like_stock_contract(contract: dict[str, Any]) -> bool:
    if contract.get("quoteCoin") != "USDT":
        return False
    if int(contract.get("state", 1)) != 0:
        return False
    if contract.get("isHidden"):
        return False

    plates = [str(item).lower() for item in contract.get("conceptPlate") or []]
    if any("stockindex" in plate for plate in plates):
        return False
    return any("stock" in plate for plate in plates)


async def match_symbols(
    mexc_symbols: list[dict[str, Any]],
    _: YahooClient,
) -> list[dict[str, Any]]:
    """Resolve MEXC stock-like contracts to Yahoo Finance ticker candidates."""

    matches: list[dict[str, Any]] = []
    seen_contracts: set[str] = set()

    for contract in mexc_symbols:
        if not _looks_like_stock_contract(contract):
            continue
        candidates = _extract_candidates(contract)
        if not candidates:
            continue
        contract_symbol = contract["symbol"]
        if contract_symbol in seen_contracts:
            continue

        yahoo_symbol = candidates[0]
        if yahoo_symbol in EXCLUDED_NON_EQUITY_TICKERS:
            continue
        if yahoo_symbol in EXCLUDED_ANOMALOUS_TICKERS:
            continue

        matches.append(
            {
                "symbol": yahoo_symbol,
                "mexc_symbol": contract_symbol,
                "yahoo_symbol": yahoo_symbol,
            }
        )
        seen_contracts.add(contract_symbol)

    logger.info("Matched %s MEXC contracts to Yahoo symbols", len(matches))
    return matches
