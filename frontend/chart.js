const HISTORY_HOURS = 24;
const SUPPORTED_INTERVALS = [5, 15, 60];

const params = new URLSearchParams(window.location.search);

const state = {
    symbol: (params.get("symbol") || "").trim().toUpperCase(),
    ticker: (params.get("ticker") || "").trim().toUpperCase(),
    yahooSymbol: (params.get("yahoo") || params.get("ticker") || "").trim().toUpperCase(),
    intervalMinutes: SUPPORTED_INTERVALS.includes(Number(params.get("interval")))
        ? Number(params.get("interval"))
        : 5,
    chart: null,
    series: null,
};

const elements = {
    pageTitle: document.getElementById("pageTitle"),
    pageSubtitle: document.getElementById("pageSubtitle"),
    mexcLink: document.getElementById("mexcLink"),
    yahooLink: document.getElementById("yahooLink"),
    controlsText: document.getElementById("controlsText"),
    chartContainer: document.getElementById("chartContainer"),
    statusBox: document.getElementById("statusBox"),
    statOpen: document.getElementById("statOpen"),
    statHigh: document.getElementById("statHigh"),
    statLow: document.getElementById("statLow"),
    statClose: document.getElementById("statClose"),
    statCount: document.getElementById("statCount"),
    intervalButtons: Array.from(document.querySelectorAll("[data-interval]")),
};

function getMexcPairUrl(symbol) {
    return `https://www.mexc.com/ru-RU/futures/${encodeURIComponent(symbol)}`;
}

function getYahooQuoteUrl(symbol) {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
}

function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "—";
    }
    return `${Number(value).toFixed(2)}%`;
}

function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function setStatus(message, isError = false) {
    elements.statusBox.textContent = message;
    elements.statusBox.classList.toggle("bad", isError);
}

function setIntervalState() {
    elements.intervalButtons.forEach((button) => {
        button.classList.toggle("active", Number(button.dataset.interval) === state.intervalMinutes);
    });
}

function ensureChart() {
    if (state.chart) {
        return;
    }

    state.chart = LightweightCharts.createChart(elements.chartContainer, {
        autoSize: true,
        layout: {
            background: { color: "#090d14" },
            textColor: "#8d9ab0",
        },
        grid: {
            vertLines: { color: "rgba(84, 101, 129, 0.08)" },
            horzLines: { color: "rgba(84, 101, 129, 0.08)" },
        },
        rightPriceScale: {
            borderColor: "rgba(133, 150, 179, 0.16)",
        },
        timeScale: {
            borderColor: "rgba(133, 150, 179, 0.16)",
            timeVisible: true,
            secondsVisible: false,
        },
        crosshair: {
            vertLine: {
                color: "rgba(49, 196, 141, 0.25)",
                labelBackgroundColor: "#0b1018",
            },
            horzLine: {
                color: "rgba(49, 196, 141, 0.25)",
                labelBackgroundColor: "#0b1018",
            },
        },
        localization: {
            priceFormatter: (price) => `${Number(price).toFixed(2)}%`,
        },
    });

    state.series = state.chart.addCandlestickSeries({
        upColor: "#31c48d",
        downColor: "#f87171",
        wickUpColor: "#31c48d",
        wickDownColor: "#f87171",
        borderUpColor: "#31c48d",
        borderDownColor: "#f87171",
        priceLineVisible: true,
        lastValueVisible: true,
    });
}

function updateStats(candles) {
    const last = candles[candles.length - 1];
    if (!last) {
        elements.statOpen.textContent = "-";
        elements.statHigh.textContent = "-";
        elements.statLow.textContent = "-";
        elements.statClose.textContent = "-";
        elements.statCount.textContent = "0";
        return;
    }

    elements.statOpen.textContent = formatPercent(last.open);
    elements.statHigh.textContent = formatPercent(last.high);
    elements.statLow.textContent = formatPercent(last.low);
    elements.statClose.textContent = formatPercent(last.close);
    elements.statCount.textContent = String(candles.length);
}

function renderCandles(candles) {
    ensureChart();

    const seriesData = candles.map((candle) => ({
        time: Math.floor(new Date(candle.time).getTime() / 1000),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
    }));

    state.series.setData(seriesData);
    state.chart.timeScale().fitContent();
    updateStats(candles);

    const lastCandle = candles[candles.length - 1];
    elements.controlsText.textContent = `Последние ${HISTORY_HOURS} часа истории spread_pct. Интервал свечи: ${state.intervalMinutes} мин. Последняя свеча: ${formatTime(lastCandle.time)}.`;
}

async function loadCandles() {
    if (!state.symbol) {
        setStatus("Не указан символ для графика. Открой страницу через кнопку \"График\" из таблицы.", true);
        return;
    }

    setStatus("Загружаю свечи спреда...");
    setIntervalState();

    try {
        const response = await fetch(
            `/api/candles/${encodeURIComponent(state.symbol)}?hours=${HISTORY_HOURS}&interval_minutes=${state.intervalMinutes}`,
        );
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.detail || "Свечи пока недоступны");
        }

        const payload = await response.json();
        const candles = payload.candles || [];
        if (!candles.length) {
            throw new Error("История ещё не накоплена");
        }

        renderCandles(candles);
        setStatus(
            `Свечи построены по локальной истории spread_pct для ${state.symbol}. Это агрегированные снимки сервиса, а не биржевые свечи Yahoo.`,
        );
    } catch (error) {
        updateStats([]);
        if (state.series) {
            state.series.setData([]);
        }
        elements.controlsText.textContent = `Последние ${HISTORY_HOURS} часа истории spread_pct.`;
        setStatus(error.message, true);
    }
}

function initPage() {
    const titleTicker = state.ticker || state.yahooSymbol || state.symbol;
    elements.pageTitle.textContent = titleTicker
        ? `Свечной график спреда: ${titleTicker}`
        : "Свечной график спреда";
    elements.pageSubtitle.textContent = state.symbol
        ? `Контракт ${state.symbol}. Свечи строятся по локально сохранённому spread_pct за последние ${HISTORY_HOURS} часа и агрегируются в выбранный интервал.`
        : "Свечи строятся по локально сохранённому spread_pct за последние 24 часа.";

    elements.mexcLink.href = state.symbol ? getMexcPairUrl(state.symbol) : "#";
    elements.yahooLink.href = state.yahooSymbol ? getYahooQuoteUrl(state.yahooSymbol) : "#";

    elements.intervalButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const nextInterval = Number(button.dataset.interval);
            if (!SUPPORTED_INTERVALS.includes(nextInterval) || nextInterval === state.intervalMinutes) {
                return;
            }
            state.intervalMinutes = nextInterval;
            loadCandles().catch(() => {});
        });
    });
}

initPage();
loadCandles().catch(() => {});
