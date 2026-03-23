from __future__ import annotations

import asyncio
import base64
import binascii
import io
import logging
import os
import secrets
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .matcher import match_symbols
from .mexc import MexcClient
from .storage import Storage
from .yahoo import YahooClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"

MEXC_REFRESH_SECONDS = 3
YAHOO_REFRESH_SECONDS = 3
REMATCH_INTERVAL = timedelta(minutes=15)
DEFAULT_MIN_SPREAD_PCT = 1.5
DEFAULT_MAX_SPREAD_PCT = 50.0
SUPPORTED_CANDLE_INTERVALS = {5, 15, 60}
PUBLIC_BASIC_AUTH_USER = os.getenv("PUBLIC_BASIC_AUTH_USER", "")
PUBLIC_BASIC_AUTH_PASSWORD = os.getenv("PUBLIC_BASIC_AUTH_PASSWORD", "")


def _database_path() -> Path:
    configured_path = os.getenv("SPREAD_MONITOR_DB_PATH")
    if configured_path:
        return Path(configured_path).expanduser()
    return ROOT_DIR / "data" / "database.db"


DATABASE_PATH = _database_path()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


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


def _frame_to_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    if frame.empty:
        return []
    clean = frame.where(pd.notnull(frame), None)
    return clean.to_dict(orient="records")


def _public_auth_enabled() -> bool:
    return bool(PUBLIC_BASIC_AUTH_USER and PUBLIC_BASIC_AUTH_PASSWORD)


def _is_authorized(auth_header: str | None) -> bool:
    if not _public_auth_enabled():
        return True
    if not auth_header or not auth_header.startswith("Basic "):
        return False

    encoded = auth_header.removeprefix("Basic ").strip()
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return False

    username, separator, password = decoded.partition(":")
    if not separator:
        return False

    return (
        secrets.compare_digest(username, PUBLIC_BASIC_AUTH_USER)
        and secrets.compare_digest(password, PUBLIC_BASIC_AUTH_PASSWORD)
    )


def _unauthorized_response() -> Response:
    return Response(
        content="Authentication required",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="spread-monitor"'},
        media_type="text/plain",
    )


class SpreadMonitor:
    def __init__(self) -> None:
        self.mexc = MexcClient()
        self.yahoo = YahooClient()
        self.storage = Storage(DATABASE_PATH)
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._snapshot_rows: list[dict[str, Any]] = []
        self._matches: list[dict[str, Any]] = []
        self._contracts_by_symbol: dict[str, dict[str, Any]] = {}
        self._updated_at: str | None = None
        self._last_yahoo_refresh_at: datetime | None = None
        self._last_match_at: datetime | None = None
        self._errors = {"mexc": None, "yahoo": None}

    async def start(self) -> None:
        await self.storage.initialize()
        self._task = asyncio.create_task(self._run_loop(), name="spread-monitor")

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
        await self.mexc.close()

    async def _run_loop(self) -> None:
        while True:
            started_at = _utcnow()
            try:
                await self.refresh_once()
            except Exception:
                logger.exception("Unexpected error in refresh loop")

            elapsed = (_utcnow() - started_at).total_seconds()
            await asyncio.sleep(max(1.0, MEXC_REFRESH_SECONDS - elapsed))

    def _pick_yahoo_price(self, quote: dict[str, Any]) -> tuple[float | None, str]:
        after_hours_price = _coerce_float(quote.get("after_hours_price"))
        current_price = _coerce_float(quote.get("current_price"))
        previous_close = _coerce_float(quote.get("previous_close"))

        if after_hours_price is not None:
            return after_hours_price, "after-hours"
        if current_price is not None:
            return current_price, "market"
        return previous_close, "previous-close"

    def _build_rows(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        recorded_at = _utcnow().isoformat()

        for match in self._matches:
            mexc_symbol = match["mexc_symbol"]
            contract = self._contracts_by_symbol.get(mexc_symbol)
            if not contract:
                continue

            yahoo_quote = self.yahoo.get_cached_price(match["yahoo_symbol"])
            if not yahoo_quote:
                continue
            quote_type = str(yahoo_quote.get("quote_type") or "").upper()
            if quote_type and quote_type != "EQUITY":
                continue

            yahoo_price, price_source = self._pick_yahoo_price(yahoo_quote)
            mexc_price = _coerce_float(contract.get("lastPrice"))
            mexc_mark_price = _coerce_float(contract.get("fairPrice"))
            funding_rate = _coerce_float(contract.get("fundingRate"))

            if yahoo_price in (None, 0) or mexc_price is None:
                continue

            spread_abs = mexc_price - yahoo_price
            spread_pct = (spread_abs / yahoo_price) * 100

            rows.append(
                {
                    "recorded_at": recorded_at,
                    "symbol": match["symbol"],
                    "mexc_symbol": mexc_symbol,
                    "yahoo_symbol": match["yahoo_symbol"],
                    "yahoo_price": yahoo_price,
                    "yahoo_current_price": _coerce_float(yahoo_quote.get("current_price")),
                    "yahoo_after_hours_price": _coerce_float(yahoo_quote.get("after_hours_price")),
                    "yahoo_previous_close": _coerce_float(yahoo_quote.get("previous_close")),
                    "yahoo_price_source": price_source,
                    "mexc_price": mexc_price,
                    "mexc_mark_price": mexc_mark_price,
                    "funding_rate": funding_rate,
                    "spread_abs": spread_abs,
                    "spread_pct": spread_pct,
                    "updated_at": recorded_at,
                }
            )

        if not rows:
            return []

        frame = pd.DataFrame(rows)
        frame["abs_spread_pct"] = frame["spread_pct"].abs()
        frame = frame.sort_values(
            by=["abs_spread_pct", "symbol"],
            ascending=[False, True],
        ).drop(columns=["abs_spread_pct"])
        return _frame_to_records(frame)

    async def refresh_once(self) -> None:
        try:
            contracts = await self.mexc.get_all_symbols()
        except Exception as exc:
            self._errors["mexc"] = str(exc)
            logger.warning("MEXC refresh failed: %s", exc)
            return

        self._errors["mexc"] = None
        self._contracts_by_symbol = {
            contract["symbol"]: contract for contract in contracts if contract.get("symbol")
        }

        now = _utcnow()
        if not self._matches or self._last_match_at is None or now - self._last_match_at >= REMATCH_INTERVAL:
            try:
                self._matches = await match_symbols(contracts, self.yahoo)
                self._last_match_at = now
            except Exception as exc:
                logger.warning("Symbol matching failed: %s", exc)

        yahoo_symbols = sorted({row["yahoo_symbol"] for row in self._matches})
        if yahoo_symbols and (
            self._last_yahoo_refresh_at is None
            or now - self._last_yahoo_refresh_at >= timedelta(seconds=YAHOO_REFRESH_SECONDS)
        ):
            try:
                await self.yahoo.refresh_prices(yahoo_symbols)
                self._last_yahoo_refresh_at = now
                self._errors["yahoo"] = None
            except Exception as exc:
                self._errors["yahoo"] = str(exc)
                logger.warning("Yahoo refresh failed, using cached values: %s", exc)

        rows = self._build_rows()
        if rows:
            await self.storage.save_prices(rows)

        async with self._lock:
            self._snapshot_rows = rows
            self._updated_at = _utcnow().isoformat()

    def _sort_frame(self, frame: pd.DataFrame, sort_by: str) -> pd.DataFrame:
        if frame.empty:
            return frame

        if sort_by == "spread_asc":
            return frame.sort_values(by="spread_pct", ascending=True)
        return frame.sort_values(by="spread_pct", ascending=False)

    async def snapshot_payload(
        self,
        min_spread_pct: float = DEFAULT_MIN_SPREAD_PCT,
        max_spread_pct: float = DEFAULT_MAX_SPREAD_PCT,
        search: str = "",
        sort_by: str = "spread_desc",
    ) -> dict[str, Any]:
        async with self._lock:
            rows = list(self._snapshot_rows)
            updated_at = self._updated_at
            errors = dict(self._errors)
            tracked_symbols = len(self._matches)

        frame = pd.DataFrame(rows)
        if not frame.empty:
            frame["abs_spread_pct"] = frame["spread_pct"].abs()
            if search:
                pattern = search.strip()
                mask = frame["symbol"].str.contains(pattern, case=False, na=False)
                mask |= frame["mexc_symbol"].str.contains(pattern, case=False, na=False)
                mask |= frame["yahoo_symbol"].str.contains(pattern, case=False, na=False)
                frame = frame[mask]
            frame = frame[frame["abs_spread_pct"] >= min_spread_pct]
            frame = frame[frame["abs_spread_pct"] <= max_spread_pct]
            frame = self._sort_frame(frame, sort_by)
            if "abs_spread_pct" in frame.columns:
                frame = frame.drop(columns=["abs_spread_pct"])
            rows = _frame_to_records(frame)

        max_abs_spread = 0.0
        if rows:
            max_abs_spread = max(abs(row["spread_pct"]) for row in rows if row.get("spread_pct") is not None)

        return {
            "updated_at": updated_at,
            "tracked_symbols": tracked_symbols,
            "rows": rows,
            "errors": errors,
            "max_abs_spread_pct": max_abs_spread,
        }

    async def history_payload(self, symbol: str, hours: int) -> dict[str, Any]:
        points = await self.storage.get_history(symbol, hours=hours)
        return {"symbol": symbol.upper(), "hours": hours, "points": points}

    async def candles_payload(
        self,
        symbol: str,
        hours: int,
        interval_minutes: int,
    ) -> dict[str, Any]:
        points = await self.storage.get_candles(
            symbol,
            hours=hours,
            interval_minutes=interval_minutes,
        )
        return {
            "symbol": symbol.upper(),
            "hours": hours,
            "interval_minutes": interval_minutes,
            "candles": points,
        }

    async def export_csv(self, hours: int) -> str:
        return await self.storage.export_recent_csv(hours=hours)


monitor = SpreadMonitor()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await monitor.start()
    yield
    await monitor.close()


app = FastAPI(
    title="Yahoo vs MEXC Spread Monitor",
    version="1.0.0",
    lifespan=lifespan,
)
app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="assets")


@app.middleware("http")
async def public_basic_auth(request: Request, call_next):
    if not _public_auth_enabled():
        return await call_next(request)
    if _is_authorized(request.headers.get("authorization")):
        return await call_next(request)
    return _unauthorized_response()


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/chart", include_in_schema=False)
async def chart_page() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "chart.html")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "updated_at": monitor._updated_at}


@app.get("/api/snapshot")
async def snapshot(
    min_spread_pct: float = Query(default=DEFAULT_MIN_SPREAD_PCT, ge=0.0),
    max_spread_pct: float = Query(default=DEFAULT_MAX_SPREAD_PCT, ge=0.0),
    search: str = Query(default=""),
    sort_by: str = Query(default="spread_desc"),
) -> dict[str, Any]:
    return await monitor.snapshot_payload(
        min_spread_pct=min_spread_pct,
        max_spread_pct=max_spread_pct,
        search=search,
        sort_by=sort_by,
    )


@app.get("/api/history/{symbol}")
async def history(
    symbol: str,
    hours: int = Query(default=24, ge=1, le=168),
) -> dict[str, Any]:
    payload = await monitor.history_payload(symbol, hours)
    if not payload["points"]:
        raise HTTPException(status_code=404, detail="История для символа пока не накоплена")
    return payload


@app.get("/api/candles/{symbol}")
async def candles(
    symbol: str,
    hours: int = Query(default=24, ge=1, le=168),
    interval_minutes: int = Query(default=5),
) -> dict[str, Any]:
    if interval_minutes not in SUPPORTED_CANDLE_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"Поддерживаются интервалы: {sorted(SUPPORTED_CANDLE_INTERVALS)}",
        )
    payload = await monitor.candles_payload(symbol, hours, interval_minutes)
    if not payload["candles"]:
        raise HTTPException(status_code=404, detail="Свечи для символа пока не накоплены")
    return payload


@app.get("/api/export.csv")
async def export_csv(hours: int = Query(default=24, ge=1, le=168)) -> StreamingResponse:
    csv_data = await monitor.export_csv(hours=hours)
    return StreamingResponse(
        io.BytesIO(csv_data.encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="spread_history.csv"'},
    )
