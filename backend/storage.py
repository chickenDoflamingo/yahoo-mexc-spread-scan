from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Storage:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self._write_lock = asyncio.Lock()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize_sync(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS price_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recorded_at TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    mexc_symbol TEXT NOT NULL,
                    yahoo_symbol TEXT NOT NULL,
                    yahoo_price REAL,
                    yahoo_current_price REAL,
                    yahoo_after_hours_price REAL,
                    yahoo_previous_close REAL,
                    yahoo_price_source TEXT,
                    mexc_price REAL,
                    mexc_mark_price REAL,
                    funding_rate REAL,
                    spread_abs REAL,
                    spread_pct REAL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_price_history_symbol_time
                ON price_history (mexc_symbol, recorded_at)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at
                ON price_history (recorded_at)
                """
            )
            connection.commit()

    async def initialize(self) -> None:
        await asyncio.to_thread(self._initialize_sync)

    async def save_price(
        self,
        symbol: str,
        spread: float | None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        row = dict(payload or {})
        base_symbol = symbol.split("_")[0].upper()
        row.setdefault("mexc_symbol", symbol)
        row.setdefault("symbol", base_symbol)
        row.setdefault("yahoo_symbol", base_symbol)
        row.setdefault("spread_abs", spread)
        row.setdefault("mexc_price", None)
        await self.save_prices([row])

    def _save_prices_sync(self, rows: list[dict[str, Any]]) -> None:
        timestamp = _utcnow().isoformat()
        records = [
            (
                row.get("recorded_at") or timestamp,
                row.get("symbol"),
                row.get("mexc_symbol"),
                row.get("yahoo_symbol"),
                row.get("yahoo_price"),
                row.get("yahoo_current_price"),
                row.get("yahoo_after_hours_price"),
                row.get("yahoo_previous_close"),
                row.get("yahoo_price_source"),
                row.get("mexc_price"),
                row.get("mexc_mark_price"),
                row.get("funding_rate"),
                row.get("spread_abs"),
                row.get("spread_pct"),
            )
            for row in rows
        ]
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO price_history (
                    recorded_at,
                    symbol,
                    mexc_symbol,
                    yahoo_symbol,
                    yahoo_price,
                    yahoo_current_price,
                    yahoo_after_hours_price,
                    yahoo_previous_close,
                    yahoo_price_source,
                    mexc_price,
                    mexc_mark_price,
                    funding_rate,
                    spread_abs,
                    spread_pct
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                records,
            )
            connection.commit()

    async def save_prices(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        async with self._write_lock:
            await asyncio.to_thread(self._save_prices_sync, rows)

    def _get_history_sync(self, symbol: str, hours: int) -> list[dict[str, Any]]:
        since = (_utcnow() - timedelta(hours=hours)).isoformat()
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT recorded_at, spread_abs, spread_pct, yahoo_price, mexc_price,
                       mexc_mark_price, funding_rate
                FROM price_history
                WHERE mexc_symbol = ? AND recorded_at >= ?
                ORDER BY recorded_at ASC
                """,
                (symbol.upper(), since),
            ).fetchall()
        points = [dict(row) for row in rows]
        if len(points) <= 1500:
            return points

        step = max(1, len(points) // 1500)
        sampled = points[::step]
        if sampled[-1] != points[-1]:
            sampled.append(points[-1])
        return sampled

    async def get_history(self, symbol: str, hours: int = 24) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._get_history_sync, symbol, hours)

    def _get_candles_sync(
        self,
        symbol: str,
        hours: int,
        interval_minutes: int,
    ) -> list[dict[str, Any]]:
        since = (_utcnow() - timedelta(hours=hours)).isoformat()
        with self._connect() as connection:
            frame = pd.read_sql_query(
                """
                SELECT recorded_at, spread_pct
                FROM price_history
                WHERE mexc_symbol = ? AND recorded_at >= ?
                ORDER BY recorded_at ASC
                """,
                connection,
                params=(symbol.upper(), since),
            )

        if frame.empty:
            return []

        frame["recorded_at"] = pd.to_datetime(frame["recorded_at"], utc=True, errors="coerce")
        frame["spread_pct"] = pd.to_numeric(frame["spread_pct"], errors="coerce")
        frame = frame.dropna(subset=["recorded_at", "spread_pct"])
        if frame.empty:
            return []

        rule = f"{interval_minutes}min"
        candles = (
            frame.set_index("recorded_at")["spread_pct"]
            .resample(rule, label="right", closed="right")
            .ohlc()
            .dropna()
            .reset_index()
        )
        if candles.empty:
            return []

        return [
            {
                "time": row["recorded_at"].isoformat(),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
            }
            for _, row in candles.iterrows()
        ]

    async def get_candles(
        self,
        symbol: str,
        hours: int = 24,
        interval_minutes: int = 5,
    ) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            self._get_candles_sync,
            symbol,
            hours,
            interval_minutes,
        )

    def _export_recent_csv_sync(self, hours: int) -> str:
        since = (_utcnow() - timedelta(hours=hours)).isoformat()
        query = """
            SELECT recorded_at, symbol, mexc_symbol, yahoo_symbol, yahoo_price,
                   yahoo_current_price, yahoo_after_hours_price, yahoo_previous_close,
                   yahoo_price_source, mexc_price, mexc_mark_price, funding_rate,
                   spread_abs, spread_pct
            FROM price_history
            WHERE recorded_at >= ?
            ORDER BY recorded_at DESC, ABS(spread_pct) DESC
        """
        with self._connect() as connection:
            frame = pd.read_sql_query(query, connection, params=(since,))
        return frame.to_csv(index=False)

    async def export_recent_csv(self, hours: int = 24) -> str:
        return await asyncio.to_thread(self._export_recent_csv_sync, hours)
