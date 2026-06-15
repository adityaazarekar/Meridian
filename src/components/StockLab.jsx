import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, ColorType, CrosshairMode } from "lightweight-charts";
import { getStockData } from "../services/marketAPI";
import { liveSearchCompanies } from "../services/marketAPI";
import { emaSeries, rsiSeries } from "../utils/investingMath";
import { fmtNum } from "../utils/formatMetric";
import { CompanyLogo } from "./CompanyLogo";

/** Yahoo occasionally returns duplicate session dates; lightweight-charts requires unique times. */
function dedupeByTime(rows) {
  const m = new Map();
  for (const r of rows || []) m.set(r.time, r);
  return [...m.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function toLwRows(chartArr) {
  return (chartArr || [])
    .map((d) => {
      const dateRaw = (d.Date ?? d.date ?? "").toString();
      const time = dateRaw.length >= 10 ? dateRaw.slice(0, 10) : dateRaw;
      return {
        time,
        open: Number(d.Open ?? d.open),
        high: Number(d.High ?? d.high),
        low: Number(d.Low ?? d.low),
        close: Number(d.Close ?? d.close),
        volume: Number(d.Volume ?? d.volume ?? 0),
      };
    })
    .filter(
      (r) =>
        r.time &&
        !Number.isNaN(r.open) &&
        !Number.isNaN(r.high) &&
        !Number.isNaN(r.low) &&
        !Number.isNaN(r.close)
    );
}

export default function StockLab({ companies, palette, chartHeight = 380 }) {
  const P = palette || {};
  const list = companies?.length ? companies : [];
  const [symbol, setSymbol] = useState(list[0]?.symbol || "AAPL");
  const [period, setPeriod] = useState("6mo");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [rows, setRows] = useState([]);
  const [showEMA20, setShowEMA20] = useState(true);
  const [showEMA50, setShowEMA50] = useState(true);
  const [showRSI, setShowRSI] = useState(true);

  // ── Live search state ──────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [pendingSymbol, setPendingSymbol] = useState(symbol);   // typed/selected but not yet analyzed
  const searchInputRef = useRef(null);

  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const rsiBoxRef = useRef(null);
  const rsiChartRef = useRef(null);

  // Keep pending symbol in sync with dropdown selector
  useEffect(() => {
    if (list.length && !list.find((c) => c.symbol === symbol)) {
      setSymbol(list[0].symbol);
      setPendingSymbol(list[0].symbol);
    }
  }, [list, symbol]);

  // ── Debounced live search ──────────────────────────────────────────────
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await liveSearchCompanies(q);
        setSearchResults(res || []);
      } catch { setSearchResults([]); }
      finally { setSearchLoading(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ── Fetch chart data ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const data = await getStockData(symbol, period);
        if (cancelled) return;
        setMetrics(data.metrics);
        setRows(dedupeByTime(toLwRows(data.chart)));
      } catch (e) {
        if (!cancelled) setErr(e.message || "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [symbol, period]);

  // ── Handle "Analyze" button / Enter ───────────────────────────────────
  const handleAnalyze = useCallback(() => {
    const sym = pendingSymbol.trim().toUpperCase();
    if (!sym) return;
    setSearchQuery("");
    setSearchResults([]);
    setSearchFocused(false);
    setSymbol(sym);
  }, [pendingSymbol]);

  const handlePickResult = useCallback((r) => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchFocused(false);
    setPendingSymbol(r.symbol);
    setSymbol(r.symbol);
  }, []);

  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter") handleAnalyze();
    if (e.key === "Escape") { setSearchFocused(false); setSearchResults([]); }
  };

  // ── Candlestick + EMA chart ────────────────────────────────────────────
  useEffect(() => {
    if (!boxRef.current) return;
    const el = boxRef.current;
    const chart = createChart(el, {
      width: el.clientWidth || 800,
      height: chartHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#0a0e16" },
        textColor: "#94a3b8",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)" },
    });

    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: "rgba(56,189,248,0.4)",
    });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const candle = chart.addCandlestickSeries({
      upColor: P.emerald || "#34d399",
      downColor: P.rose || "#fb7185",
      borderVisible: false,
      wickUpColor: P.emerald || "#34d399",
      wickDownColor: P.rose || "#fb7185",
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });

    const candles = rows.map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close }));
    candle.setData(candles);

    vol.setData(
      rows.map((r) => ({
        time: r.time,
        value: r.volume,
        color: r.close >= r.open ? "rgba(52,211,153,0.35)" : "rgba(251,113,133,0.35)",
      }))
    );

    const closes = rows.map((r) => r.close);
    if (showEMA20 && rows.length >= 3) {
      const s = chart.addLineSeries({ color: "#a78bfa", lineWidth: 1.5, title: "EMA 20" });
      const e20 = emaSeries(closes, 20);
      s.setData(rows.map((r, i) => (e20[i] != null ? { time: r.time, value: e20[i] } : null)).filter((x) => x));
    }
    if (showEMA50 && rows.length >= 5) {
      const s = chart.addLineSeries({ color: "#38bdf8", lineWidth: 1.5, title: "EMA 50" });
      const e50 = emaSeries(closes, 50);
      s.setData(rows.map((r, i) => (e50[i] != null ? { time: r.time, value: e50[i] } : null)).filter((x) => x));
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (!boxRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: boxRef.current.clientWidth });
    });
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [rows, showEMA20, showEMA50, chartHeight, P.emerald, P.rose]);

  // ── RSI chart ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!showRSI || !rsiBoxRef.current) return;
    const el = rsiBoxRef.current;
    const rsiChart = createChart(el, {
      width: el.clientWidth || 800,
      height: 120,
      layout: {
        background: { type: ColorType.Solid, color: "#070a10" },
        textColor: "#64748b",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)" },
        horzLines: { color: "rgba(255,255,255,0.03)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.06)" },
      timeScale: { visible: false },
    });
    const line = rsiChart.addLineSeries({ color: "#e8b84b", lineWidth: 1.2 });
    const closes = rows.map((r) => r.close);
    const rsi = rsiSeries(closes, 14);
    line.setData(
      rows.map((r, i) => (rsi[i] != null ? { time: r.time, value: rsi[i] } : null)).filter((x) => x)
    );
    rsiChart.timeScale().fitContent();
    rsiChartRef.current = rsiChart;
    const ro = new ResizeObserver(() => {
      if (!rsiBoxRef.current || !rsiChartRef.current) return;
      rsiChartRef.current.applyOptions({ width: rsiBoxRef.current.clientWidth });
    });
    ro.observe(el);
    return () => { ro.disconnect(); rsiChart.remove(); rsiChartRef.current = null; };
  }, [rows, showRSI]);

  const cur = list.find((c) => c.symbol === symbol);
  const logoSrc = metrics?.logoUrl || cur?.logoUrl;
  const chg =
    metrics?.changePct != null && !Number.isNaN(metrics.changePct)
      ? `${metrics.changePct >= 0 ? "+" : ""}${fmtNum(metrics.changePct, 2, "%")}`
      : "N/A";

  const isPriceUp = (metrics?.changePct ?? 0) >= 0;

  return (
    <div className="stock-lab-wrap">
      {/* ── Hero header ─────────────────────────────────────────────── */}
      <div className="premium-hero">
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <CompanyLogo company={{ ...cur, symbol, logoUrl: logoSrc }} size={52} radius={12} />
          <div>
            <div className="premium-title">{metrics?.name || symbol}</div>
            <div className="premium-sub">
              {metrics?.exchange || "—"} · <span style={{ color: isPriceUp ? "#34d399" : "#fb7185" }}>{chg}</span> session · β {fmtNum(metrics?.beta, 2)}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select
              className="sel premium-select"
              style={{ minHeight: 44 }}
              value={symbol}
              onChange={(e) => { setSymbol(e.target.value); setPendingSymbol(e.target.value); }}
            >
              {list.map((c) => (
                <option key={c.symbol} value={c.symbol}>
                  {c.symbol} — {(c.name || c.symbol).slice(0, 32)}
                </option>
              ))}
            </select>
            <select
              className="sel premium-select"
              style={{ minHeight: 44 }}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="3mo">3M</option>
              <option value="6mo">6M</option>
              <option value="1y">1Y</option>
              <option value="2y">2Y</option>
            </select>
          </div>
        </div>

        {/* ── LIVE SEARCH + ANALYZE BAR ────────────────────────────── */}
        <div style={{ marginTop: 18, position: "relative" }}>
          <div style={{
            display: "flex", gap: 0, alignItems: "stretch",
            background: "rgba(255,255,255,0.04)",
            border: searchFocused ? "1px solid rgba(232,184,75,0.5)" : "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            boxShadow: searchFocused ? "0 0 0 3px rgba(232,184,75,0.08)" : "none",
            transition: "border-color 0.2s, box-shadow 0.2s",
            overflow: "visible",
          }}>
            {/* Search icon */}
            <div style={{ display: "flex", alignItems: "center", padding: "0 14px", color: "#64748b", fontSize: 16, flexShrink: 0 }}>
              🔍
            </div>

            {/* Text input */}
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery || pendingSymbol}
              placeholder="Search any stock — e.g. Tesla, AAPL, Colgate…"
              style={{
                flex: 1, background: "transparent", border: "none", outline: "none",
                color: "#f1f5f9", fontSize: 14, fontFamily: "'Plus Jakarta Sans', sans-serif",
                fontWeight: 500, padding: "13px 0", minWidth: 0,
              }}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPendingSymbol(e.target.value);
              }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 300)}
              onKeyDown={handleSearchKeyDown}
            />

            {/* Loading spinner inside input */}
            {searchLoading && (
              <div style={{ display: "flex", alignItems: "center", padding: "0 12px", flexShrink: 0 }}>
                <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(232,184,75,0.3)", borderTopColor: "#e8b84b", animation: "spin 0.7s linear infinite" }} />
              </div>
            )}

            {/* Clear button */}
            {(searchQuery || pendingSymbol !== symbol) && !searchLoading && (
              <button
                onClick={() => { setSearchQuery(""); setPendingSymbol(symbol); setSearchResults([]); searchInputRef.current?.focus(); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", fontSize: 16, padding: "0 10px", display: "flex", alignItems: "center", flexShrink: 0, transition: "color 0.2s" }}
                onMouseEnter={e => e.currentTarget.style.color = "#94a3b8"}
                onMouseLeave={e => e.currentTarget.style.color = "#475569"}
                title="Clear"
              >
                ✕
              </button>
            )}

            {/* ANALYZE BUTTON */}
            <button
              onClick={handleAnalyze}
              disabled={loading}
              style={{
                background: "linear-gradient(135deg, #e8b84b 0%, #d4973a 100%)",
                border: "none", cursor: loading ? "wait" : "pointer",
                color: "#080c14", fontSize: 13, fontWeight: 700,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                padding: "0 22px", borderRadius: "0 11px 11px 0",
                letterSpacing: "0.06em", textTransform: "uppercase",
                flexShrink: 0, display: "flex", alignItems: "center", gap: 7,
                transition: "opacity 0.2s, transform 0.15s",
                opacity: loading ? 0.6 : 1,
                boxShadow: "0 0 20px rgba(232,184,75,0.25)",
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.transform = "scale(1.03)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
            >
              {loading ? (
                <>
                  <div style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid rgba(8,12,20,0.3)", borderTopColor: "#080c14", animation: "spin 0.7s linear infinite" }} />
                  Analyzing…
                </>
              ) : (
                <>
                  ⚡ Analyze
                </>
              )}
            </button>
          </div>

          {/* Live search dropdown */}
          {searchFocused && searchQuery.trim() && (
            <div style={{
              position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
              background: "#0f1724",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 12, zIndex: 200,
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
              overflow: "hidden",
              animation: "scalein 0.18s cubic-bezier(.16,1,.3,1) both",
            }}>
              {searchLoading && (
                <div style={{ padding: "14px 16px", color: "#475569", fontSize: 13, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(232,184,75,0.3)", borderTopColor: "#e8b84b", animation: "spin 0.7s linear infinite" }} />
                  Searching Yahoo Finance…
                </div>
              )}
              {!searchLoading && searchResults.length === 0 && (
                <div style={{ padding: "14px 16px", color: "#475569", fontSize: 13 }}>
                  No results for <strong style={{ color: "#f1f5f9" }}>"{searchQuery}"</strong>
                  <div style={{ fontSize: 11, marginTop: 4, color: "#334155" }}>Try a ticker (e.g. AAPL) or company name</div>
                </div>
              )}
              {!searchLoading && searchResults.map((r, idx) => (
                <div
                  key={r.symbol}
                  onMouseDown={(e) => { e.preventDefault(); handlePickResult(r); }}
                  style={{
                    padding: "11px 16px",
                    display: "flex", alignItems: "center", gap: 12,
                    cursor: "pointer",
                    borderBottom: idx < searchResults.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none",
                    transition: "background 0.12s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.055)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                >
                  {/* Ticker badge */}
                  <div style={{
                    width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                    background: "rgba(232,184,75,0.1)", border: "1px solid rgba(232,184,75,0.18)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#e8b84b", fontWeight: 700,
                  }}>
                    {(r.symbol || "?").slice(0, 5)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: 11, color: "#475569", marginTop: 2, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontFamily: "'DM Mono',monospace", color: "#e8b84b" }}>{r.symbol}</span>
                      {r.exchange && (
                        <span style={{ background: "rgba(56,189,248,0.1)", color: "#38bdf8", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontWeight: 600 }}>
                          {r.exchange}
                        </span>
                      )}
                      {r.sector && <span style={{ color: "#334155" }}>{r.sector}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#e8b84b", fontWeight: 600, flexShrink: 0 }}>
                    Analyze →
                  </div>
                </div>
              ))}
              {/* Keyboard hint */}
              {!searchLoading && searchResults.length > 0 && (
                <div style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.05)", fontSize: 10, color: "#1e293b", display: "flex", gap: 12 }}>
                  <span>↵ Analyze by ticker</span>
                  <span>↑↓ Navigate</span>
                  <span>Esc Close</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── KPI row ─────────────────────────────────────────────── */}
        <div className="premium-kpi-row">
          <div>
            <div className="premium-metric-label">Last</div>
            <div className="premium-metric-val" style={{ color: P.gold }}>
              {fmtNum(metrics?.price, 2, "", "$")}
            </div>
          </div>
          <div>
            <div className="premium-metric-label">Market cap</div>
            <div className="premium-metric-val">{metrics?.capital ?? "N/A"}</div>
          </div>
          <div>
            <div className="premium-metric-label">P / E</div>
            <div className="premium-metric-val">{fmtNum(metrics?.pe, 1, "x", "")}</div>
          </div>
          <div>
            <div className="premium-metric-label">Div yield</div>
            <div className="premium-metric-val">{fmtNum(metrics?.divYield, 2, "%", "")}</div>
          </div>
          <div>
            <div className="premium-metric-label">52W range</div>
            <div className="premium-metric-val" style={{ fontSize: 15 }}>
              {fmtNum(metrics?.low52, 2, "", "$")} – {fmtNum(metrics?.high52, 2, "", "$")}
            </div>
          </div>
          <div>
            <div className="premium-metric-label">ROE</div>
            <div className="premium-metric-val">{fmtNum(metrics?.roe, 1, "%", "")}</div>
          </div>
          <div>
            <div className="premium-metric-label">Beta</div>
            <div className="premium-metric-val">{fmtNum(metrics?.beta, 2)}</div>
          </div>
        </div>
      </div>

      {/* ── Chart toolbar ────────────────────────────────────────────── */}
      <div className="stock-lab-toolbar">
        <span className="tool-chip" title="Crosshair (desktop)">⌖</span>
        <span className="tool-chip" title="Guides">╱</span>
        <label className="tool-chip togg">
          <input type="checkbox" checked={showEMA20} onChange={(e) => setShowEMA20(e.target.checked)} /> EMA 20
        </label>
        <label className="tool-chip togg">
          <input type="checkbox" checked={showEMA50} onChange={(e) => setShowEMA50(e.target.checked)} /> EMA 50
        </label>
        <label className="tool-chip togg">
          <input type="checkbox" checked={showRSI} onChange={(e) => setShowRSI(e.target.checked)} /> RSI (14)
        </label>
      </div>

      {loading && <div className="premium-hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid rgba(232,184,75,0.3)", borderTopColor: "#e8b84b", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
        Syncing price series for <strong style={{ color: "#e8b84b" }}>{symbol}</strong>…
      </div>}
      {err && <div style={{ color: "#fb7185", fontSize: 13, marginBottom: 8, padding: "8px 12px", background: "rgba(251,113,133,0.08)", borderRadius: 8, border: "1px solid rgba(251,113,133,0.15)" }}>⚠ {err}</div>}

      <div ref={boxRef} className="stock-chart-box" style={{ width: "100%", minHeight: chartHeight }} />

      {showRSI && (
        <div style={{ marginTop: 10 }}>
          <div className="clabel" style={{ marginBottom: 6 }}>RSI (14)</div>
          <div ref={rsiBoxRef} className="stock-chart-box" style={{ width: "100%", minHeight: 120 }} />
        </div>
      )}

      <div className="card premium-card" style={{ marginTop: 20, padding: "18px 20px" }}>
        <div className="clabel">Desk notes</div>
        <p className="premium-copy">
          Search any publicly listed company worldwide using the search bar above — type a name or ticker and click <strong style={{ color: "#e8b84b" }}>⚡ Analyze</strong> to load its live chart, EMA overlays, RSI, and fundamental metrics directly from Yahoo Finance. Logos use public brand marks when a corporate site is available.
        </p>
      </div>
    </div>
  );
}
