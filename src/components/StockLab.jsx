import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, CrosshairMode } from "lightweight-charts";
import { getStockData } from "../services/marketAPI";
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

  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const rsiBoxRef = useRef(null);
  const rsiChartRef = useRef(null);

  useEffect(() => {
    if (list.length && !list.find((c) => c.symbol === symbol)) {
      setSymbol(list[0].symbol);
    }
  }, [list, symbol]);

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
    return () => {
      cancelled = true;
    };
  }, [symbol, period]);

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

    const candles = rows.map((r) => ({
      time: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
    }));
    candle.setData(candles);

    vol.setData(
      rows.map((r) => ({
        time: r.time,
        value: r.volume,
        color: r.close >= r.open ? "rgba(52,211,153,0.35)" : "rgba(251,113,133,0.35)",
      }))
    );

    const closes = rows.map((r) => r.close);
    const emaLines = [];
    if (showEMA20 && rows.length >= 3) {
      const s = chart.addLineSeries({ color: "#a78bfa", lineWidth: 1.5, title: "EMA 20" });
      const e20 = emaSeries(closes, 20);
      s.setData(rows.map((r, i) => (e20[i] != null ? { time: r.time, value: e20[i] } : null)).filter((x) => x));
      emaLines.push(s);
    }
    if (showEMA50 && rows.length >= 5) {
      const s = chart.addLineSeries({ color: "#38bdf8", lineWidth: 1.5, title: "EMA 50" });
      const e50 = emaSeries(closes, 50);
      s.setData(rows.map((r, i) => (e50[i] != null ? { time: r.time, value: e50[i] } : null)).filter((x) => x));
      emaLines.push(s);
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (!boxRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: boxRef.current.clientWidth });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [rows, showEMA20, showEMA50, chartHeight, P.emerald, P.rose]);

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
    return () => {
      ro.disconnect();
      rsiChart.remove();
      rsiChartRef.current = null;
    };
  }, [rows, showRSI]);

  const cur = list.find((c) => c.symbol === symbol);
  const logoSrc = metrics?.logoUrl || cur?.logoUrl;

  const chg =
    metrics?.changePct != null && !Number.isNaN(metrics.changePct)
      ? `${metrics.changePct >= 0 ? "+" : ""}${fmtNum(metrics.changePct, 2, "%")}`
      : "N/A";

  return (
    <div className="stock-lab-wrap">
      <div className="premium-hero">
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <CompanyLogo company={{ ...cur, symbol, logoUrl: logoSrc }} size={52} radius={12} />
          <div>
            <div className="premium-title">{metrics?.name || symbol}</div>
            <div className="premium-sub">
              {metrics?.exchange || "—"} · {chg} session · β {fmtNum(metrics?.beta, 2)}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select
              className="sel premium-select"
              style={{ minHeight: 44 }}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
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
            </select>
          </div>
        </div>
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
        </div>
      </div>

      <div className="stock-lab-toolbar">
        <span className="tool-chip" title="Crosshair (desktop)">
          ⌖
        </span>
        <span className="tool-chip" title="Guides">
          ╱
        </span>
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

      {loading && <div className="premium-hint">Syncing price series…</div>}
      {err && <div style={{ color: "#fb7185", fontSize: 13, marginBottom: 8 }}>{err}</div>}

      <div ref={boxRef} className="stock-chart-box" style={{ width: "100%", minHeight: chartHeight }} />

      {showRSI && (
        <div style={{ marginTop: 10 }}>
          <div className="clabel" style={{ marginBottom: 6 }}>
            RSI (14)
          </div>
          <div ref={rsiBoxRef} className="stock-chart-box" style={{ width: "100%", minHeight: 120 }} />
        </div>
      )}

      <div className="card premium-card" style={{ marginTop: 20, padding: "18px 20px" }}>
        <div className="clabel">Desk notes</div>
        <p className="premium-copy">
          Candlesticks, volume, and EMA overlays read directly from your Meridian API (Yahoo Finance). RSI helps flag
          overbought / oversold stretches — pair with fundamentals and liquidity on other tabs before sizing trades.
          Logos use public brand marks when a corporate site is available; they may be blocked by ad blockers.
        </p>
      </div>
    </div>
  );
}
