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
}

function renderChart(symbol, points) {
    const labels = points.map((point) => formatChartTime(point.recorded_at));
    const data = points.map((point) => Number(point.spread_pct));

    if (!state.chart) {
        state.chart = new Chart(elements.chartCanvas, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Spread %",
                        data,
                        borderColor: "#4eff78",
                        backgroundColor: "rgba(78, 255, 120, 0.08)",
                        fill: true,
                        borderWidth: 1.5,
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        tension: 0.32,
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
                            label(context) {
                                return `Спред: ${formatPercent(context.parsed.y)}`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        grid: {
                            color: "rgba(78, 255, 120, 0.06)",
                        },
                        ticks: {
                            color: "#7cb07c",
                            autoSkip: true,
                            maxTicksLimit: 10,
                        },
                    },
                    y: {
                        grid: {
                            color: "rgba(78, 255, 120, 0.06)",
                        },
                        ticks: {
                            color: "#7cb07c",
                            callback(value) {
                                return `${value}%`;
                            },
                        },
                    },
                },
            },
        });
    } else {
        state.chart.data.labels = labels;
        state.chart.data.datasets[0].data = data;
        state.chart.update();
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
