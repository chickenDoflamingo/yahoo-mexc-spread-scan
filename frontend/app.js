const REFRESH_MS = 3000;
const HISTORY_HOURS = 24;
const ALERT_COOLDOWN_MS = 30000;
const DEFAULT_MIN_SPREAD_PCT = 0;
const REQUEST_MAX_SPREAD_PCT = 1000000;

const state = {
    rows: [],
    selectedSymbol: null,
    selectedRow: null,
    chart: null,
    chartBounds: null,
    chartViewportDirty: false,
    chartPan: null,
    chartControlsBound: false,
    lastAlertAt: 0,
    audioContext: null,
    soundEnabled: localStorage.getItem("spread_sound_enabled") === "true",
    alertThreshold: Number(localStorage.getItem("spread_alert_threshold") || 2),
    refreshInFlight: false,
};

function getMexcPairUrl(symbol) {
    return `https://www.mexc.com/ru-RU/futures/${encodeURIComponent(symbol)}`;
}

function getYahooQuoteUrl(symbol) {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
}

const elements = {
    statusText: document.getElementById("statusText"),
    searchInput: document.getElementById("searchInput"),
    minSpreadInput: document.getElementById("minSpreadInput"),
    maxSpreadInput: document.getElementById("maxSpreadInput"),
    sortSelect: document.getElementById("sortSelect"),
    alertThresholdInput: document.getElementById("alertThresholdInput"),
    soundToggle: document.getElementById("soundToggle"),
    tableBody: document.getElementById("tableBody"),
    detailPanel: document.getElementById("detailPanel"),
    panelEyebrow: document.getElementById("panelEyebrow"),
    panelTitle: document.getElementById("panelTitle"),
    panelSubtitle: document.getElementById("panelSubtitle"),
    panelYahoo: document.getElementById("panelYahoo"),
    panelMexc: document.getElementById("panelMexc"),
    panelSpreadPct: document.getElementById("panelSpreadPct"),
    panelFunding: document.getElementById("panelFunding"),
    chartCanvas: document.getElementById("spreadChart"),
    resetZoomBtn: document.getElementById("resetZoomBtn"),
};

function formatPrice(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "—";
    }
    return Number(value).toLocaleString("ru-RU", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    });
}

function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "—";
    }
    return `${Number(value).toFixed(2)}%`;
}

function formatSpreadPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "—";
    }
    return formatPercent(Math.abs(Number(value)));
}

function formatSpreadPrice(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "—";
    }
    return Math.abs(Number(value)).toFixed(4);
}

function formatFunding(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "—";
    }
    return `${(Number(value) * 100).toFixed(4)}%`;
}

function formatTime(value) {
    if (!value) {
        return "ожидание";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatChartTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatAxisTime(value) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) {
        return "—";
    }
    return date.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getCanvasPosition(event) {
    const rect = elements.chartCanvas.getBoundingClientRect();
    return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
    };
}

function computeChartBounds(dataPoints) {
    if (!dataPoints.length) {
        return null;
    }

    const xValues = dataPoints.map((point) => point.x);
    const yValues = dataPoints.map((point) => point.y);
    const rawXMin = Math.min(...xValues);
    const rawXMax = Math.max(...xValues);
    const rawYMin = Math.min(...yValues);
    const rawYMax = Math.max(...yValues);

    const xRange = Math.max(rawXMax - rawXMin, 10_000);
    const yRange = Math.max(rawYMax - rawYMin, 0.08);
    const yPadding = Math.max(yRange * 0.14, 0.03);

    return {
        xMin: rawXMin - Math.min(2_000, xRange * 0.02),
        xMax: rawXMax + Math.min(2_000, xRange * 0.02),
        yMin: rawYMin - yPadding,
        yMax: rawYMax + yPadding,
        minXRange: Math.max(xRange * 0.02, 3_000),
        minYRange: Math.max(yRange * 0.08, 0.02),
    };
}

function getCurrentViewport(chart) {
    return {
        xMin: Number(chart.options.scales.x.min ?? chart.scales.x.min),
        xMax: Number(chart.options.scales.x.max ?? chart.scales.x.max),
        yMin: Number(chart.options.scales.y.min ?? chart.scales.y.min),
        yMax: Number(chart.options.scales.y.max ?? chart.scales.y.max),
    };
}

function normalizeViewport(viewport, bounds) {
    if (!bounds) {
        return viewport;
    }

    let { xMin, xMax, yMin, yMax } = viewport;
    const fullXRange = bounds.xMax - bounds.xMin;
    const fullYRange = bounds.yMax - bounds.yMin;

    let xRange = xMax - xMin;
    if (xRange >= fullXRange) {
        xMin = bounds.xMin;
        xMax = bounds.xMax;
    } else {
        if (xRange < bounds.minXRange) {
            const xCenter = (xMin + xMax) / 2;
            xRange = bounds.minXRange;
            xMin = xCenter - xRange / 2;
            xMax = xCenter + xRange / 2;
        }
        if (xMin < bounds.xMin) {
            xMax += bounds.xMin - xMin;
            xMin = bounds.xMin;
        }
        if (xMax > bounds.xMax) {
            xMin -= xMax - bounds.xMax;
            xMax = bounds.xMax;
        }
    }

    let yRange = yMax - yMin;
    if (yRange >= fullYRange) {
        yMin = bounds.yMin;
        yMax = bounds.yMax;
    } else {
        if (yRange < bounds.minYRange) {
            const yCenter = (yMin + yMax) / 2;
            yRange = bounds.minYRange;
            yMin = yCenter - yRange / 2;
            yMax = yCenter + yRange / 2;
        }
        if (yMin < bounds.yMin) {
            yMax += bounds.yMin - yMin;
            yMin = bounds.yMin;
        }
        if (yMax > bounds.yMax) {
            yMin -= yMax - bounds.yMax;
            yMax = bounds.yMax;
        }
    }

    return { xMin, xMax, yMin, yMax };
}

function applyViewport(chart, viewport) {
    chart.options.scales.x.min = viewport.xMin;
    chart.options.scales.x.max = viewport.xMax;
    chart.options.scales.y.min = viewport.yMin;
    chart.options.scales.y.max = viewport.yMax;
}

function isViewportOriginal(viewport, bounds) {
    if (!bounds) {
        return true;
    }
    const epsilon = 0.000001;
    return (
        Math.abs(viewport.xMin - bounds.xMin) < epsilon &&
        Math.abs(viewport.xMax - bounds.xMax) < epsilon &&
        Math.abs(viewport.yMin - bounds.yMin) < epsilon &&
        Math.abs(viewport.yMax - bounds.yMax) < epsilon
    );
}

function resetChartViewport(updateChart = true) {
    if (!state.chart || !state.chartBounds) {
        return;
    }
    applyViewport(state.chart, state.chartBounds);
    state.chartViewportDirty = false;
    if (updateChart) {
        state.chart.update("none");
    }
}

function bindChartControls() {
    if (state.chartControlsBound) {
        return;
    }

    elements.resetZoomBtn.addEventListener("click", () => {
        resetChartViewport(true);
    });

    elements.chartCanvas.addEventListener("dblclick", () => {
        resetChartViewport(true);
    });

    elements.chartCanvas.addEventListener("wheel", (event) => {
        if (!state.chart || !state.chartBounds) {
            return;
        }

        const chart = state.chart;
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const position = getCanvasPosition(event);
        const { left, right, top, bottom } = chart.chartArea;
        if (position.x < left || position.x > right || position.y < top || position.y > bottom) {
            return;
        }

        event.preventDefault();
        const currentViewport = getCurrentViewport(chart);
        const zoomFactor = event.deltaY < 0 ? 0.86 : 1.16;
        const focusX = clamp(xScale.getValueForPixel(position.x), currentViewport.xMin, currentViewport.xMax);
        const focusY = clamp(yScale.getValueForPixel(position.y), currentViewport.yMin, currentViewport.yMax);
        const nextViewport = normalizeViewport(
            {
                xMin: focusX - (focusX - currentViewport.xMin) * zoomFactor,
                xMax: focusX + (currentViewport.xMax - focusX) * zoomFactor,
                yMin: focusY - (focusY - currentViewport.yMin) * zoomFactor,
                yMax: focusY + (currentViewport.yMax - focusY) * zoomFactor,
            },
            state.chartBounds,
        );

        applyViewport(chart, nextViewport);
        state.chartViewportDirty = !isViewportOriginal(nextViewport, state.chartBounds);
        chart.update("none");
    }, { passive: false });

    elements.chartCanvas.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || !state.chart || !state.chartBounds) {
            return;
        }

        const chart = state.chart;
        const position = getCanvasPosition(event);
        const { left, right, top, bottom } = chart.chartArea;
        if (position.x < left || position.x > right || position.y < top || position.y > bottom) {
            return;
        }

        state.chartPan = {
            startPosition: position,
            startViewport: getCurrentViewport(chart),
        };
        elements.chartCanvas.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (event) => {
        if (!state.chartPan || !state.chart || !state.chartBounds) {
            return;
        }

        const chart = state.chart;
        const position = getCanvasPosition(event);
        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const startViewport = state.chartPan.startViewport;
        const startPosition = state.chartPan.startPosition;

        const deltaX = xScale.getValueForPixel(startPosition.x) - xScale.getValueForPixel(position.x);
        const deltaY = yScale.getValueForPixel(startPosition.y) - yScale.getValueForPixel(position.y);

        const nextViewport = normalizeViewport(
            {
                xMin: startViewport.xMin + deltaX,
                xMax: startViewport.xMax + deltaX,
                yMin: startViewport.yMin + deltaY,
                yMax: startViewport.yMax + deltaY,
            },
            state.chartBounds,
        );

        applyViewport(chart, nextViewport);
        state.chartViewportDirty = !isViewportOriginal(nextViewport, state.chartBounds);
        chart.update("none");
    });

    window.addEventListener("mouseup", () => {
        state.chartPan = null;
        elements.chartCanvas.style.cursor = "grab";
    });

    elements.chartCanvas.style.cursor = "grab";
    state.chartControlsBound = true;
}

function directionBadge(value) {
    if (Number(value) < 0) {
        return '<span class="symbol-direction symbol-direction-long" title="MEXC ниже Yahoo: лонг">↑</span>';
    }
    if (Number(value) > 0) {
        return '<span class="symbol-direction symbol-direction-short" title="MEXC выше Yahoo: шорт">↓</span>';
    }
    return "";
}

function ensureAudioContext() {
    if (!state.soundEnabled) {
        return null;
    }
    if (!state.audioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            return null;
        }
        state.audioContext = new AudioCtx();
    }
    return state.audioContext;
}

function playAlert() {
    const audioContext = ensureAudioContext();
    if (!audioContext) {
        return;
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.value = 880;
    gainNode.gain.value = 0.001;

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    const now = audioContext.currentTime;
    gainNode.gain.exponentialRampToValueAtTime(0.1, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

    oscillator.start(now);
    oscillator.stop(now + 0.35);
}

function maybeTriggerAlert(rows) {
    if (!state.soundEnabled) {
        return;
    }
    const threshold = Number(state.alertThreshold);
    const now = Date.now();
    if (now - state.lastAlertAt < ALERT_COOLDOWN_MS) {
        return;
    }
    const hasAlert = rows.some((row) => Math.abs(Number(row.spread_pct || 0)) >= threshold);
    if (!hasAlert) {
        return;
    }
    playAlert();
    state.lastAlertAt = now;
}

function updateSummary(payload) {
    const tracked = String(payload.tracked_symbols ?? 0);
    const updated = formatTime(payload.updated_at);
    const maxSpread = formatPercent(payload.max_abs_spread_pct || 0);
    const minSpread = getMinSpreadFilterValue();
    const maxSpreadFilter = getMaxSpreadFilterValue();
    const rangeText = buildFilterSummaryText(minSpread, maxSpreadFilter);

    const errors = payload.errors || {};
    const errorMessages = Object.entries(errors)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${key}: ${value}`);

    if (errorMessages.length) {
        elements.statusText.textContent = `TRACKED ${tracked} | MAX ${maxSpread} | UPDATE ${updated} | ${rangeText} Проблемы источников: ${errorMessages.join(" | ")}`;
        elements.statusText.classList.add("bad");
        return;
    }

    elements.statusText.textContent = `TRACKED ${tracked} | MAX ${maxSpread} | UPDATE ${updated} | ${rangeText} Кнопка "Рынок" открывает Yahoo Finance, кнопка "График" прокручивает к истории выбранного тикера.`;
    elements.statusText.classList.remove("bad");
}

function renderTable(rows) {
    const minSpread = getMinSpreadFilterValue();
    const maxSpread = getMaxSpreadFilterValue();
    const rangeText = buildFilterLabelText(minSpread, maxSpread);

    if (!rows.length) {
        elements.tableBody.innerHTML = `
            <tr>
                <td colspan="7" class="empty-state">Подходящих спредов сейчас нет. Текущий фильтр: ${rangeText}.</td>
            </tr>
        `;
        return;
    }

    const html = rows.map((row) => `
        <tr data-symbol="${row.mexc_symbol}">
            <td>
                <div class="symbol-row">
                    <a class="symbol-link" href="${getMexcPairUrl(row.mexc_symbol)}" rel="noreferrer" target="_blank">${directionBadge(row.spread_pct)}${row.symbol}</a>
                    <div class="symbol-meta">
                        <a class="symbol-sub symbol-sub-link" href="${getMexcPairUrl(row.mexc_symbol)}" rel="noreferrer" target="_blank">${row.mexc_symbol}</a>
                        <button class="symbol-chart-btn" type="button" data-history-symbol="${row.mexc_symbol}">График</button>
                    </div>
                </div>
            </td>
            <td class="number">
                ${formatPrice(row.yahoo_price)}
                <div class="market-actions">
                    <a class="market-link-btn" href="${getYahooQuoteUrl(row.yahoo_symbol)}" target="_blank" rel="noopener noreferrer">Рынок</a>
                </div>
            </td>
            <td class="number">${formatPrice(row.mexc_price)}</td>
            <td class="number">${formatPrice(row.mexc_mark_price)}</td>
            <td class="number">${formatFunding(row.funding_rate)}</td>
            <td class="number">${formatSpreadPrice(row.spread_abs)}</td>
            <td class="number">${formatSpreadPercent(row.spread_pct)}</td>
        </tr>
    `).join("");

    elements.tableBody.innerHTML = html;
}

function renderPanelSnapshot(row) {
    if (!row) {
        return;
    }
    elements.panelEyebrow.textContent = `${row.mexc_symbol} / ${row.yahoo_symbol}`;
    elements.panelTitle.textContent = row.symbol;
    elements.panelSubtitle.textContent = `Линейный график ниже показывает историю spread_pct за последние ${HISTORY_HOURS} часа и обновляется каждые ${REFRESH_MS / 1000} секунды.`;
    elements.panelYahoo.textContent = `${formatPrice(row.yahoo_price)} $`;
    elements.panelMexc.textContent = `${formatPrice(row.mexc_price)} $`;
    elements.panelSpreadPct.textContent = formatSpreadPercent(row.spread_pct);
    elements.panelFunding.textContent = formatFunding(row.funding_rate);
}

function destroyChart() {
    if (state.chart) {
        state.chart.destroy();
        state.chart = null;
    }
    state.chartBounds = null;
    state.chartViewportDirty = false;
    state.chartPan = null;
}

function renderChart(symbol, points) {
    const dataPoints = points
        .map((point) => ({
            x: new Date(point.recorded_at).getTime(),
            y: Number(point.spread_pct),
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        .sort((left, right) => left.x - right.x);

    if (!dataPoints.length) {
        renderHistoryEmpty("История ещё не накоплена. Нужно немного времени, чтобы сервис собрал точки из локальных снимков.");
        return;
    }

    state.chartBounds = computeChartBounds(dataPoints);

    if (!state.chart) {
        state.chart = new Chart(elements.chartCanvas, {
            type: "line",
            data: {
                datasets: [
                    {
                        label: "Spread %",
                        data: dataPoints,
                        borderColor: "#4eff78",
                        backgroundColor: "rgba(78, 255, 120, 0.08)",
                        fill: true,
                        borderWidth: 1.5,
                        parsing: false,
                        normalized: true,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        tension: 0.18,
                    },
                ],
            },
            options: {
                maintainAspectRatio: false,
                animation: {
                    duration: 180,
                },
                interaction: {
                    intersect: false,
                    mode: "index",
                },
                plugins: {
                    decimation: {
                        enabled: true,
                        algorithm: "lttb",
                        samples: 240,
                    },
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#020402",
                        borderColor: "rgba(78, 255, 120, 0.28)",
                        borderWidth: 1,
                        titleColor: "#f4fff4",
                        bodyColor: "#f4fff4",
                        displayColors: false,
                        callbacks: {
                            title(items) {
                                return formatChartTime(items[0].parsed.x);
                            },
                            label(context) {
                                return `Спред: ${formatPercent(context.parsed.y)}`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        type: "linear",
                        min: state.chartBounds?.xMin,
                        max: state.chartBounds?.xMax,
                        grid: {
                            color: "rgba(78, 255, 120, 0.12)",
                            lineWidth: 1,
                        },
                        border: {
                            color: "rgba(78, 255, 120, 0.22)",
                        },
                        ticks: {
                            color: "#9ad39a",
                            autoSkip: true,
                            maxTicksLimit: 12,
                            callback(value) {
                                return formatAxisTime(value);
                            },
                        },
                    },
                    y: {
                        type: "linear",
                        min: state.chartBounds?.yMin,
                        max: state.chartBounds?.yMax,
                        grid: {
                            color: "rgba(78, 255, 120, 0.12)",
                            lineWidth: 1,
                        },
                        border: {
                            color: "rgba(78, 255, 120, 0.22)",
                        },
                        ticks: {
                            color: "#9ad39a",
                            precision: 2,
                            maxTicksLimit: 9,
                            callback(value) {
                                return `${Number(value).toFixed(2)}%`;
                            },
                        },
                    },
                },
            },
        });
        bindChartControls();
    } else {
        state.chart.data.datasets[0].data = dataPoints;

        if (state.chartViewportDirty) {
            const currentViewport = getCurrentViewport(state.chart);
            applyViewport(state.chart, normalizeViewport(currentViewport, state.chartBounds));
        } else {
            applyViewport(state.chart, state.chartBounds);
        }

        state.chart.update();
    }

    if (!state.chartViewportDirty) {
        applyViewport(state.chart, state.chartBounds);
        state.chart.update("none");
    }

    if (state.selectedRow) {
        elements.panelTitle.textContent = `${state.selectedRow.symbol} / ${symbol}`;
    }
}

function renderHistoryEmpty(message) {
    elements.panelEyebrow.textContent = state.selectedSymbol || "SPREAD GRAPH";
    elements.panelTitle.textContent = "История недоступна";
    elements.panelSubtitle.textContent = message;
    elements.panelYahoo.textContent = "-";
    elements.panelMexc.textContent = "-";
    elements.panelSpreadPct.textContent = "-";
    elements.panelFunding.textContent = "-";
    destroyChart();
}

async function refreshSelectedHistory(scroll = false) {
    if (!state.selectedSymbol) {
        return;
    }

    const response = await fetch(`/api/history/${encodeURIComponent(state.selectedSymbol)}?hours=${HISTORY_HOURS}`);
    if (!response.ok) {
        renderHistoryEmpty("История ещё не накоплена. Нужно немного времени, чтобы сервис собрал точки из локальных снимков.");
        if (scroll) {
            elements.detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
    }

    const payload = await response.json();
    renderChart(state.selectedSymbol, payload.points || []);

    const liveRow = state.rows.find((row) => row.mexc_symbol === state.selectedSymbol);
    if (liveRow) {
        state.selectedRow = liveRow;
    }
    renderPanelSnapshot(state.selectedRow);

    if (scroll) {
        elements.detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

async function fetchSnapshot() {
    const minSpread = getMinSpreadFilterValue();
    const maxSpread = getMaxSpreadFilterValue();

    const params = new URLSearchParams({
        search: elements.searchInput.value.trim(),
        sort_by: elements.sortSelect.value,
        min_spread_pct: String(minSpread),
        max_spread_pct: String(Number.isFinite(maxSpread) ? maxSpread : REQUEST_MAX_SPREAD_PCT),
    });

    const response = await fetch(`/api/snapshot?${params.toString()}`);
    if (!response.ok) {
        throw new Error("Не удалось получить снимок рынка");
    }

    const payload = await response.json();
    state.rows = payload.rows || [];

    if (!state.selectedSymbol && state.rows.length) {
        state.selectedSymbol = state.rows[0].mexc_symbol;
        state.selectedRow = state.rows[0];
    } else if (state.selectedSymbol) {
        const matchingRow = state.rows.find((row) => row.mexc_symbol === state.selectedSymbol);
        if (matchingRow) {
            state.selectedRow = matchingRow;
        }
    }

    updateSummary(payload);
    renderTable(state.rows);
    maybeTriggerAlert(state.rows);
    await refreshSelectedHistory(false);
}

async function runRefreshCycle() {
    if (state.refreshInFlight) {
        return;
    }
    state.refreshInFlight = true;

    try {
        await fetchSnapshot();
    } catch (error) {
        elements.statusText.textContent = error.message;
        elements.statusText.classList.add("bad");
    } finally {
        state.refreshInFlight = false;
    }
}

function getMinSpreadFilterValue() {
    return Math.max(0, Number(elements.minSpreadInput.value || DEFAULT_MIN_SPREAD_PCT));
}

function getMaxSpreadFilterValue() {
    const rawValue = elements.maxSpreadInput.value.trim();
    if (!rawValue) {
        return Number.POSITIVE_INFINITY;
    }
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return Number.POSITIVE_INFINITY;
    }
    return parsed;
}

function buildFilterSummaryText(minSpread, maxSpread) {
    if (Number.isFinite(maxSpread)) {
        return `Фильтр: ${formatPercent(minSpread)} - ${formatPercent(maxSpread)}.`;
    }
    return `Фильтр: от ${formatPercent(minSpread)} без верхнего лимита.`;
}

function buildFilterLabelText(minSpread, maxSpread) {
    if (Number.isFinite(maxSpread)) {
        return `${formatPercent(minSpread)}-${formatPercent(maxSpread)}`;
    }
    return `от ${formatPercent(minSpread)}`;
}

function scheduleRefresh() {
    runRefreshCycle().catch(() => {});
    window.setInterval(() => {
        runRefreshCycle().catch(() => {});
    }, REFRESH_MS);
}

function initControls() {
    elements.soundToggle.checked = state.soundEnabled;
    elements.alertThresholdInput.value = String(state.alertThreshold);
    elements.minSpreadInput.value = String(DEFAULT_MIN_SPREAD_PCT);

    [elements.searchInput, elements.minSpreadInput, elements.maxSpreadInput, elements.sortSelect].forEach((element) => {
        element.addEventListener("input", () => {
            runRefreshCycle().catch(() => {});
        });
        element.addEventListener("change", () => {
            runRefreshCycle().catch(() => {});
        });
    });

    elements.alertThresholdInput.addEventListener("change", () => {
        state.alertThreshold = Number(elements.alertThresholdInput.value || 2);
        localStorage.setItem("spread_alert_threshold", String(state.alertThreshold));
    });

    elements.soundToggle.addEventListener("change", async () => {
        state.soundEnabled = elements.soundToggle.checked;
        localStorage.setItem("spread_sound_enabled", String(state.soundEnabled));

        if (state.soundEnabled) {
            const audioContext = ensureAudioContext();
            if (audioContext && audioContext.state === "suspended") {
                await audioContext.resume();
            }
        }
    });

    elements.tableBody.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const historyButton = target.closest("[data-history-symbol]");
        if (historyButton) {
            const symbol = historyButton.getAttribute("data-history-symbol");
            if (!symbol) {
                return;
            }
            state.selectedSymbol = symbol;
            state.selectedRow = state.rows.find((row) => row.mexc_symbol === symbol) || state.selectedRow;
            refreshSelectedHistory(true).catch(() => {});
            return;
        }

        if (target.closest(".symbol-link, .symbol-sub-link, .market-link-btn")) {
            return;
        }

        const row = target.closest("tr[data-symbol]");
        if (!row) {
            return;
        }
        const symbol = row.getAttribute("data-symbol");
        if (!symbol) {
            return;
        }
        state.selectedSymbol = symbol;
        state.selectedRow = state.rows.find((item) => item.mexc_symbol === symbol) || state.selectedRow;
        refreshSelectedHistory(true).catch(() => {});
    });
}

initControls();
scheduleRefresh();
