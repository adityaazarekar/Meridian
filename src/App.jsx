import { useState, useEffect, useMemo, useRef } from "react";
import "./App.css";
import {
  getGlobalTickers,
  getBatchQuotes,
  getStockData,
  normalizeChart,
  stubsFromGlobalMap,
  mergeApiMetricsToCompany,
} from "./services/marketAPI";
import { fmtNum, getCurrencySymbol, fmtLocalPrice, fmtUsdBn } from "./utils/formatMetric";
import StockLab from "./components/StockLab";
import { CompanyLogo } from "./components/CompanyLogo";
import { CountryFlag } from "./components/CountryFlag";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, LineChart, Line, AreaChart, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  PieChart, Pie, Cell, Treemap, ComposedChart, Legend, ReferenceLine, Brush
} from "recharts";

// ─── PALETTE & GICS COLORS ──────────────────────────────────────────────────
const P = {
  bg: "#080c14", surface: "rgba(255,255,255,0.03)", card: "rgba(255,255,255,0.055)",
  border: "rgba(255,255,255,0.09)",
  gold: "#e8b84b", goldDim: "rgba(232,184,75,0.15)",
  emerald: "#34d399", sky: "#38bdf8", rose: "#fb7185", violet: "#a78bfa",
  amber: "#fbbf24", slate: "#94a3b8", slateD: "#475569", white: "#f1f5f9",
};

const ACCENT = ["#e8b84b", "#34d399", "#38bdf8", "#fb7185", "#a78bfa", "#fbbf24", "#f472b6", "#4ade80"];

const GICS_COLORS = {
  "Information Technology": "#38bdf8",
  "Health Care": "#34d399",
  "Financials": "#e8b84b",
  "Consumer Discretionary": "#fb7185",
  "Communication Services": "#a78bfa",
  "Industrials": "#94a3b8",
  "Consumer Staples": "#f472b6",
  "Energy": "#fbbf24",
  "Materials": "#a3e635",
  "Real Estate": "#2dd4bf",
  "Utilities": "#60a5fa"
};

// ─── HELPER FUNCTIONS ───────────────────────────────────────────────────────
function rnd(a, b) { return Math.random() * (b - a) + a; }

function finiteMean(values) {
  const nums = (values || []).filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Coerce market / chart numbers so rollups never become NaN. */
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Sector treemap: `capitalGravity` is aggregate market cap in **billions USD**. */
function formatCapGravityBn(bn) {
  if (!Number.isFinite(bn) || bn < 0) return "—";
  if (bn >= 1000) return `$${(bn / 1000).toFixed(2)}T`;
  return `$${bn.toFixed(1)}B`;
}

function treemapShortName(name, maxPx, fontPx) {
  if (!name) return "";
  const approx = Math.max(4, Math.floor(maxPx / (fontPx * 0.52)) - 1);
  if (name.length <= approx) return name;
  return `${name.slice(0, Math.max(3, approx - 1))}…`;
}

/** Custom Recharts treemap cell — clipped labels, no NaNB, luxury strokes. */
function TreemapSectorPremium(treemapProps) {
  const { x, y, width, height, name, index, payload } = treemapProps;
  const raw = payload?.size ?? payload?.value ?? treemapProps.size ?? treemapProps.value;
  const cap = safeNum(raw, 0);
  const c = payload?.color || "#e8b84b";
  const inset = 2;
  const rx = 4;
  const ix = x + inset;
  const iy = y + inset;
  const iw = width - inset * 2;
  const ih = height - inset * 2;
  if (iw < 10 || ih < 10) return null;

  const fs = Math.min(13, Math.max(9, iw / 11));
  const shortName = treemapShortName(name, iw - 8, fs);
  const valStr = formatCapGravityBn(cap);
  const clipId = `tmclip-${index}-${Math.round(ix)}-${Math.round(iy)}`;

  return (
    <g className="treemap-sector-node">
      <defs>
        <clipPath id={clipId}>
          <rect x={ix} y={iy} width={iw} height={ih} rx={rx} ry={rx} />
        </clipPath>
      </defs>
      <title>{`${name} · ${valStr}`}</title>
      <rect
        x={ix}
        y={iy}
        width={iw}
        height={ih}
        fill={c}
        fillOpacity={0.68}
        stroke="#05080f"
        strokeWidth={2}
        rx={rx}
        ry={rx}
        style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,.45))" }}
      />
      <g clipPath={`url(#${clipId})`}>
        {iw > 56 && ih > 26 && (
          <text
            x={ix + iw / 2}
            y={iy + ih / 2 - (ih > 48 ? 8 : 0)}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#f8fafc"
            fontSize={fs}
            fontFamily="'Plus Jakarta Sans', system-ui, sans-serif"
            fontWeight={600}
          >
            {shortName}
          </text>
        )}
        {iw > 60 && ih > 46 && (
          <text
            x={ix + iw / 2}
            y={iy + ih / 2 + 12}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="rgba(248,250,252,0.58)"
            fontSize={Math.max(9, fs - 2)}
            fontFamily="'DM Mono', ui-monospace, monospace"
          >
            {valStr}
          </text>
        )}
      </g>
    </g>
  );
}

function downloadTextFile(filename, text) {
  try {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* noop */
  }
}

// ─── DYNAMIC ROLLUP FUNCTIONS ───────────────────────────────────────────────
function buildSectorRollup(companies) {
  const sectors = [...new Set(companies.map(c => c.sector))];
  const SECTOR_COLORS = {};
  sectors.forEach((s, i) => SECTOR_COLORS[s] = GICS_COLORS[s] || ACCENT[i % ACCENT.length]);

  return sectors.map(s => {
    const g = companies.filter(c => c.sector === s);
    return {
      sector: s, short: s.slice(0, 12),
      capitalGravity: g.reduce((a, c) => a + safeNum(c.capitalGravity, 0), 0),
      revenueFlow: g.reduce((a, c) => a + safeNum(c.revenueFlow, 0), 0),
      netYield: g.reduce((a, c) => a + safeNum(c.netYield, 0), 0),
      count: g.length,
      avgValuation: safeNum(g.reduce((a, c) => a + safeNum(c.valuationIndex, 0), 0) / (g.length || 1), 0),
      avgGrowth: safeNum(g.reduce((a, c) => a + safeNum(c.growthMomentum, 0), 0) / (g.length || 1), 0),
      avgLiquidity: safeNum(g.reduce((a, c) => a + safeNum(c.liquidityScore, 0), 0) / (g.length || 1), 0),
      color: SECTOR_COLORS[s],
    };
  }).sort((a, b) => b.capitalGravity - a.capitalGravity);
}

function buildCountryRollup(companies) {
  const countries = [...new Set(companies.map(c => c.country))];
  const COUNTRY_COLORS = {};
  countries.forEach((c, i) => COUNTRY_COLORS[c] = ACCENT[i % ACCENT.length]);

  return countries.map(cn => {
    const g = companies.filter(c => c.country === cn);
    return {
      country: cn,
      capitalGravity: g.reduce((a, c) => a + safeNum(c.capitalGravity, 0), 0),
      revenueFlow: g.reduce((a, c) => a + safeNum(c.revenueFlow, 0), 0),
      netYield: g.reduce((a, c) => a + safeNum(c.netYield, 0), 0),
      count: g.length,
      avgValuation: safeNum(g.reduce((a, c) => a + safeNum(c.valuationIndex, 0), 0) / (g.length || 1), 0),
      avgGrowth: safeNum(g.reduce((a, c) => a + safeNum(c.growthMomentum, 0), 0) / (g.length || 1), 0),
      avgLiquidity: safeNum(g.reduce((a, c) => a + safeNum(c.liquidityScore, 0), 0) / (g.length || 1), 0),
      avgRisk: safeNum(g.reduce((a, c) => a + safeNum(c.riskCoefficient, 0), 0) / (g.length || 1), 0),
      efficiencyRatio: safeNum(g.reduce((a, c) => a + safeNum(c.efficiencyRatio, 0), 0) / (g.length || 1), 0),
      color: COUNTRY_COLORS[cn]
    };
  }).sort((a, b) => b.capitalGravity - a.capitalGravity);
}

function buildWaterfall(companies, countryName) {
  const cr = buildCountryRollup(companies).find(c => c.country === countryName) || buildCountryRollup(companies)[0];
  if (!cr) return [];

  const rev = cr.revenueFlow;
  const cogs = -rev * 0.40; const opex = -rev * 0.20; const tax = -(rev + cogs + opex) * 0.22; const net = rev + cogs + opex + tax;
  const steps = [
    { name: "Gross Revenue", value: rev, cumulative: rev },
    { name: "Cost of Revenue", value: cogs, cumulative: rev + cogs },
    { name: "Operating Costs", value: opex, cumulative: rev + cogs + opex },
    { name: "Tax Provision", value: tax, cumulative: rev + cogs + opex + tax },
    { name: "Net Yield", value: net, cumulative: net },
  ];
  return steps.map((it, i) => ({
    ...it, i, base: i === 0 || i === steps.length - 1 ? 0 : Math.min(steps[i - 1].cumulative, it.cumulative),
    barVal: Math.abs(it.value), isPositive: it.value >= 0, isTotal: i === 0 || i === steps.length - 1,
  }));
}

function buildCompanyWaterfall(company) {
  const rev = company?.revenueFlow || 0;
  const cogs = -rev * 0.42;
  const opex = -rev * 0.18;
  const net = company?.netYield ?? (rev + cogs + opex);
  const tax = net - (rev + cogs + opex);
  const steps = [
    { name: "Gross Revenue", value: rev, cumulative: rev },
    { name: "Cost of Revenue", value: cogs, cumulative: rev + cogs },
    { name: "Operating Costs", value: opex, cumulative: rev + cogs + opex },
    { name: "Tax / Other", value: tax, cumulative: rev + cogs + opex + tax },
    { name: "Net Yield", value: net, cumulative: net },
  ];
  return steps.map((it, i) => ({
    ...it, i, base: i === 0 || i === steps.length - 1 ? 0 : Math.min(steps[i - 1].cumulative, it.cumulative),
    barVal: Math.abs(it.value), isPositive: it.value >= 0, isTotal: i === 0 || i === steps.length - 1,
  }));
}

function buildCompanySeries(company, days = 50) {
  const base = company?.sharePrice || 200;
  const amp = Math.max(20, base * 0.06);
  const drift = (company?.growthMomentum || 0) / days;
  return Array.from({ length: days }, (_, i) => ({
    i: i + 1,
    label: `D${i + 1}`,
    Price: base + Math.sin(i / 6) * amp + Math.sin(i / 11) * amp * 0.4 + drift * i * 10 + rnd(-amp * 0.12, amp * 0.12),
  }));
}
// ─── PARTICLE CANVAS ────────────────────────────────────────────────────────
function ParticleCanvas() {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animId, particles = [];
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize(); window.addEventListener('resize', resize);
    for (let i = 0; i < 50; i++) particles.push({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.5 + 0.5, o: Math.random() * 0.3 + 0.1
    });
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(232,184,75,${p.o})`; ctx.fill();
      });
      // connections
      for (let i = 0; i < particles.length; i++) for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(232,184,75,${0.06 * (1 - dist / 120)})`;
          ctx.lineWidth = 0.5; ctx.stroke();
        }
      }
      animId = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={canvasRef} className="particle-canvas" />;
}

// ─── VISUAL COMPONENTS (Spark, Gauge, Tooltip, etc.) ───────────────────────
const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#111827", border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: "12px 16px", fontSize: 14, fontFamily: "'Plus Jakarta Sans',sans-serif", boxShadow: "0 20px 60px rgba(0,0,0,.6)" }}>
      {label !== undefined && <div style={{ color: P.gold, fontWeight: 700, fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>}
      {payload.map((p, i) => (
        <div key={i} style={{ color: P.white, marginTop: 4, display: "flex", justifyContent: "space-between", gap: 24 }}>
          <span style={{ color: P.slateD, fontWeight: 500 }}>{p.name}</span>
          <span style={{ fontFamily: "'DM Mono',monospace", color: p.color || P.white, fontWeight: 600 }}>{typeof p.value === "number" ? p.value.toFixed(1) : p.value}</span>
        </div>
      ))}
    </div>
  );
};

function Spark({ data, color = P.gold, w = 110, h = 36 }) {
  if (!data?.length) return null;
  const mn = Math.min(...data), mx = Math.max(...data), range = mx - mn || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - mn) / range) * (h - 4) - 2}`);
  const area = [...pts, `${w},${h}`, `0,${h}`].join(" ");
  const id = `sg${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg width={w} height={h} style={{ overflow: "visible", opacity: .85 }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={.4} /><stop offset="100%" stopColor={color} stopOpacity={.02} /></linearGradient></defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.8} style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
    </svg>
  );
}

function Gauge({ value, max = 100, color = P.gold, size = 96, label = "" }) {
  const r = size / 2 - 9, circ = 2 * Math.PI * r, arc = circ * 0.75;
  const v = Number.isFinite(value) ? value : 0;
  const fill = arc * (Math.min(v, max) / max);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width={size} height={size} style={{ transform: "rotate(135deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth={7} strokeDasharray={`${arc} ${circ - arc}`} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={7} strokeDasharray={`${fill} ${circ - fill}`} strokeLinecap="round" style={{ filter: `drop-shadow(0 0 5px ${color}88)`, transition: "stroke-dasharray 1.2s cubic-bezier(.16,1,.3,1)" }} />
        <text x={size / 2} y={size / 2 + 1} textAnchor="middle" dominantBaseline="middle" style={{ fontFamily: "'DM Mono',monospace", fontSize: 17, fill: P.white, transform: `rotate(-135deg)`, transformOrigin: `${size / 2}px ${size / 2}px` }}>{Number.isFinite(value) ? Math.round(value) : "—"}</text>
      </svg>
      <span style={{ fontSize: 11, color: P.slateD, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function HeatMap({ data }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginBottom: 4 }}>
        <div style={{ width: 30 }} />
        {months.map(m => <div key={m} style={{ flex: 1, fontSize: 8, color: P.slateD, textAlign: "center", letterSpacing: ".04em" }}>{m}</div>)}
      </div>
      {data.map((row, ri) => (
        <div key={ri} style={{ display: "flex", gap: 2, marginBottom: 3, alignItems: "center" }}>
          <div style={{ width: 30, fontSize: 9, color: P.slateD, textAlign: "right", paddingRight: 6 }}>{days[ri]}</div>
          {row.map((cell, ci) => (
            <div key={ci} style={{ flex: 1, height: 15, borderRadius: 3, background: `rgba(232,184,75,${cell.value / 100 * 0.85 + 0.05})`, opacity: .35 + cell.value / 100 * .65, cursor: "pointer", transition: "transform .15s" }}
              onMouseEnter={e => e.target.style.transform = "scale(1.3)"}
              onMouseLeave={e => e.target.style.transform = "scale(1)"}
              title={`${days[ri]} ${months[ci]}: ${cell.value.toFixed(0)}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Waterfall({ items }) {
  return (
    <ResponsiveContainer width="100%" height={210}>
      <ComposedChart data={items} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
        <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
        <XAxis dataKey="name" tick={{ fill: P.slateD, fontSize: 12, fontFamily: "Plus Jakarta Sans" }} tickLine={false} axisLine={false} />
        <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
        <Tooltip content={<TT />} />
        <Bar dataKey="base" stackId="wf" fill="transparent" legendType="none" />
        <Bar dataKey="barVal" name="Value" stackId="wf" radius={[4, 4, 0, 0]}>
          {items.map((it, i) => (<Cell key={i} fill={it.isTotal ? P.gold : it.isPositive ? P.emerald : P.rose} fillOpacity={.82} />))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function CorrMatrix() {
  const metrics = ["Capital Gravity", "Revenue Flow", "Net Yield", "Valuation", "Share Price", "Liquidity", "Momentum", "Risk"];
  const vals = [[1, .83, .76, .29, .64, .47, .35, -.21], [.83, 1, .91, .18, .52, .39, .41, -.18], [.76, .91, 1, .14, .48, .33, .38, -.15], [.29, .18, .14, 1, .55, .22, .61, .43], [.64, .52, .48, .55, 1, .31, .44, .19], [.47, .39, .33, .22, .31, 1, .28, -.38], [.35, .41, .38, .61, .44, .28, 1, -.52], [-.21, -.18, -.15, .43, .19, -.38, -.52, 1]];
  const clr = v => v >= .7 ? P.emerald : v >= .4 ? P.sky : v >= 0 ? P.slateD : v >= -.3 ? P.amber : P.rose;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ padding: "6px 8px", width: 90 }} />
            {metrics.map(m => <th key={m} style={{ padding: "5px 8px", fontSize: 11, color: P.slateD, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", whiteSpace: "nowrap", textAlign: "center" }}>{m}</th>)}
          </tr>
        </thead>
        <tbody>
          {metrics.map((row, r) => (
            <tr key={row}>
              <td style={{ padding: "5px 10px", fontSize: 11, color: P.slateD, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{row}</td>
              {vals[r].map((v, c) => (
                <td key={c} style={{ padding: "3px" }}>
                  <div style={{ background: clr(v) + "1a", border: `1px solid ${clr(v)}30`, borderRadius: 6, padding: "8px 6px", textAlign: "center", fontFamily: "DM Mono", fontSize: 14, color: clr(v), fontWeight: 600, minWidth: 54, transition: "background .2s, transform .15s", cursor: "default" }}
                    onMouseEnter={e => e.currentTarget.style.background = clr(v) + "35"}
                    onMouseLeave={e => e.currentTarget.style.background = clr(v) + "1a"}>
                    {v.toFixed(2)}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── LOADING SCREEN ─────────────────────────────────────────────────────────
const LOAD_MESSAGES = [
  "Connecting to global markets…",
  "Fetching live equity data…",
  "Computing financial metrics…",
  "Aggregating sector intelligence…",
  "Calibrating risk coefficients…",
  "Syncing price histories…",
  "Building market overview…",
  "Almost ready…",
];

function MeridianLoadingScreen() {
  const [progress, setProgress] = useState(0);
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    // Simulate progress — accelerates then slows near 90%
    const ticks = [
      { delay: 200, add: 8 }, { delay: 400, add: 10 }, { delay: 600, add: 9 },
      { delay: 800, add: 8 }, { delay: 1200, add: 7 }, { delay: 1800, add: 6 },
      { delay: 2500, add: 5 }, { delay: 3500, add: 4 }, { delay: 5000, add: 3 },
      { delay: 7000, add: 2 }, { delay: 10000, add: 1 },
    ];
    const timers = [];
    let total = 0;
    for (const { delay, add } of ticks) {
      total += add;
      const capped = Math.min(total, 90);
      timers.push(setTimeout(() => setProgress(capped), delay));
    }
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setMsgIdx(i => (i + 1) % LOAD_MESSAGES.length), 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <style>{`
        @keyframes meridian-spin-outer {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes meridian-spin-inner {
          from { transform: rotate(0deg); }
          to { transform: rotate(-360deg); }
        }
        @keyframes meridian-pulse-glow {
          0%, 100% { box-shadow: 0 0 32px rgba(232,184,75,0.35), 0 0 80px rgba(232,184,75,0.12); }
          50% { box-shadow: 0 0 48px rgba(232,184,75,0.55), 0 0 120px rgba(232,184,75,0.22); }
        }
        @keyframes meridian-shimmer {
          0% { background-position: -400px 0; }
          100% { background-position: 400px 0; }
        }
        @keyframes meridian-fade-msg {
          0% { opacity: 0; transform: translateY(6px); }
          15%, 85% { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-6px); }
        }
        @keyframes meridian-dot-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-8px); opacity: 1; }
        }
      `}</style>
      <ParticleCanvas />
      <div style={{
        position: "fixed", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", zIndex: 10,
        background: "radial-gradient(ellipse at 50% 40%, rgba(232,184,75,0.05) 0%, transparent 65%), #080c14",
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}>
        {/* Orbital rings */}
        <div style={{ position: "relative", width: 160, height: 160, marginBottom: 48 }}>
          {/* Outer ring */}
          <div style={{
            position: "absolute", inset: 0, borderRadius: "50%",
            border: "2px solid transparent",
            borderTopColor: "rgba(232,184,75,0.8)",
            borderRightColor: "rgba(232,184,75,0.2)",
            animation: "meridian-spin-outer 1.8s linear infinite",
          }} />
          {/* Middle ring */}
          <div style={{
            position: "absolute", inset: 16, borderRadius: "50%",
            border: "1.5px solid transparent",
            borderTopColor: "rgba(52,211,153,0.7)",
            borderLeftColor: "rgba(52,211,153,0.2)",
            animation: "meridian-spin-inner 2.4s linear infinite",
          }} />
          {/* Inner ring */}
          <div style={{
            position: "absolute", inset: 32, borderRadius: "50%",
            border: "1px solid transparent",
            borderTopColor: "rgba(56,189,248,0.6)",
            borderRightColor: "rgba(56,189,248,0.15)",
            animation: "meridian-spin-outer 3.2s linear infinite",
          }} />
          {/* Logo center */}
          <div style={{
            position: "absolute", inset: 44,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #e8b84b 0%, #d4973a 100%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            animation: "meridian-pulse-glow 2.5s ease-in-out infinite",
          }}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <path d="M6 30 L18 8 L30 30" stroke="#080c14" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M10 22 L18 8 L26 22" stroke="#080c14" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" strokeOpacity="0.5" />
            </svg>
          </div>
        </div>

        {/* Brand name */}
        <div style={{
          fontSize: 28, fontWeight: 800, letterSpacing: ".18em", textTransform: "uppercase",
          color: "#f1f5f9", marginBottom: 8,
          textShadow: "0 0 40px rgba(232,184,75,0.25)",
        }}>
          MERIDIAN
        </div>
        <div style={{ fontSize: 12, color: "rgba(148,163,184,0.6)", letterSpacing: ".3em", textTransform: "uppercase", marginBottom: 48 }}>
          Global Market Intelligence
        </div>

        {/* Status message */}
        <div style={{ height: 24, marginBottom: 32, overflow: "hidden", position: "relative", width: 320, textAlign: "center" }}>
          <div key={msgIdx} style={{
            fontSize: 14, color: P.slateD, animation: "meridian-fade-msg 2.2s ease forwards",
            position: "absolute", width: "100%", left: 0,
          }}>
            {LOAD_MESSAGES[msgIdx]}
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ width: 320, marginBottom: 20 }}>
          <div style={{
            width: "100%", height: 3, borderRadius: 999,
            background: "rgba(255,255,255,0.07)", overflow: "hidden",
          }}>
            <div style={{
              height: "100%", borderRadius: 999,
              width: `${progress}%`,
              transition: "width 0.8s cubic-bezier(0.25, 1, 0.5, 1)",
              background: "linear-gradient(90deg, #e8b84b, #34d399, #38bdf8, #e8b84b)",
              backgroundSize: "400px 100%",
              animation: "meridian-shimmer 2s linear infinite",
              boxShadow: "0 0 12px rgba(232,184,75,0.5)",
            }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
            <span style={{ fontSize: 11, color: "rgba(148,163,184,0.4)", fontFamily: "'DM Mono', monospace" }}>
              Initialising
            </span>
            <span style={{ fontSize: 11, color: "rgba(232,184,75,0.7)", fontFamily: "'DM Mono', monospace" }}>
              {Math.round(progress)}%
            </span>
          </div>
        </div>

        {/* Dot indicators */}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 6, height: 6, borderRadius: "50%",
              background: P.gold,
              animation: `meridian-dot-bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
            }} />
          ))}
        </div>
      </div>
    </>
  );
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────────────
export default function App({ user, onLogout }) {
  const [data, setData] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  const [tab, setTab] = useState("global");
  const [sector, setSector] = useState("All");
  const [country, setCountry] = useState("United States");
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyId, setCompanyId] = useState(null);
  const [live, setLive] = useState({ gi: 4821, vol: 68, momentum: 73, heat: 41 });

  // Portfolio Builder state
  const [portfolio, setPortfolio] = useState({});
  const [portfolioBudget] = useState(100);
  const [portfolioCountry, setPortfolioCountry] = useState("All");

  // Peer Comparison state
  const [peerIds, setPeerIds] = useState([]);
  const [peerSearch, setPeerSearch] = useState("");

  // Watchlist & Sort state
  const [watchlist, setWatchlist] = useState([]);
  const [sortCol, setSortCol] = useState('capitalGravity');
  const [sortDir, setSortDir] = useState('desc');

  // Global search
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  // Company modal
  const [modalCompany, setModalCompany] = useState(null);
  const modalSymRef = useRef("");
  const countryInitRef = useRef(false);
  const marketLoadSessionRef = useRef(0);
  const hadSuccessfulMarketFetchRef = useRef(false);

  const [chartH, setChartH] = useState(350);
  useEffect(() => {
    const upd = () => setChartH(typeof window !== "undefined" && window.innerWidth < 768 ? 220 : 350);
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);

  const [reloadTick, setReloadTick] = useState(0);

  // Load market data (global ticker map + batched yfinance metrics)
  useEffect(() => {
    const session = ++marketLoadSessionRef.current;
    let cancelled = false;

    const loadAll = async () => {
      if (!hadSuccessfulMarketFetchRef.current) {
        setDataLoading(true);
      }
      setDataError(null);
      try {
        const map = await getGlobalTickers();
        if (cancelled || marketLoadSessionRef.current !== session) return;

        const stubs = stubsFromGlobalMap(map);
        const bySymbol = Object.fromEntries(stubs.map((s) => [s.symbol, { ...s }]));
        const symbols = stubs.map((s) => s.symbol);
        const chunk = 20;
        const parts = [];
        for (let i = 0; i < symbols.length; i += chunk) {
          parts.push(symbols.slice(i, i + chunk));
        }
        const batchResults = await Promise.all(parts.map((part) => getBatchQuotes(part)));
        if (cancelled || marketLoadSessionRef.current !== session) return;

        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          const batch = batchResults[p];
          for (const sym of part) {
            const m = batch[sym];
            if (bySymbol[sym]) {
              bySymbol[sym] = mergeApiMetricsToCompany(bySymbol[sym], m);
            }
          }
        }
        const merged = stubs.map((s) => bySymbol[s.symbol] || s);
        if (cancelled || marketLoadSessionRef.current !== session) return;

        setData((prev) => {
          if (!prev.length) return merged;
          const histMap = Object.fromEntries(
            prev.filter((x) => x.priceHistory?.length).map((x) => [x.id, x.priceHistory])
          );
          return merged.map((row) => ({
            ...row,
            priceHistory: histMap[row.id] || row.priceHistory,
          }));
        });
        if (merged.length && !countryInitRef.current) {
          setCountry(merged[0].country);
          countryInitRef.current = true;
        }
        hadSuccessfulMarketFetchRef.current = true;
      } catch (err) {
        if (!cancelled && marketLoadSessionRef.current === session) {
          setDataError(err.message || "Failed to load market data");
        }
      } finally {
        if (!cancelled && marketLoadSessionRef.current === session) {
          setDataLoading(false);
        }
      }
    };

    loadAll();
    const poll = setInterval(loadAll, 60000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [reloadTick]);

  useEffect(() => {
    const id = setInterval(() => {
      setLive(p => ({
        gi: Math.round(p.gi + rnd(-15, 20)),
        vol: Math.min(100, Math.max(0, p.vol + rnd(-3, 3))),
        momentum: Math.min(100, Math.max(0, p.momentum + rnd(-2, 2))),
        heat: Math.min(100, Math.max(0, p.heat + rnd(-4, 4))),
      }));
    }, 2500);
    return () => clearInterval(id);
  }, []);

  // Derived State (memoized)
  const SECTORS = useMemo(() => [...new Set(data.map(c => c.sector))].sort(), [data]);
  const COUNTRIES = useMemo(() => [...new Set(data.map(c => c.country))].sort(), [data]);
  const SECTOR_COLORS = useMemo(() => {
    const map = {};
    SECTORS.forEach((s, i) => map[s] = GICS_COLORS[s] || ACCENT[i % ACCENT.length]);
    return map;
  }, [SECTORS]);

  const filtered = useMemo(() => data.filter(c => sector === "All" || c.sector === sector), [data, sector]);

  /** Live-safe aggregates for dividend / income screens (ignores nulls). */
  const dividendScreen = useMemo(() => {
    const withYield = filtered.filter(
      (c) => c.dividendYield != null && typeof c.dividendYield === "number" && !Number.isNaN(c.dividendYield)
    );
    const nonPayers = filtered.length - withYield.length;
    return {
      avgDivYield: finiteMean(withYield.map((c) => c.dividendYield)),
      avgPE: finiteMean(filtered.map((c) => c.peRatio)),
      avgPB: finiteMean(filtered.map((c) => c.pbRatio)),
      avgROE: finiteMean(filtered.map((c) => c.roe)),
      avgSharpe: finiteMean(filtered.map((c) => c.sharpeRatio)),
      avgEbitda: finiteMean(filtered.map((c) => c.ebitdaMargin)),
      avgPayout: finiteMean(filtered.map((c) => c.payoutRatioPct)),
      avgDiv5Y: finiteMean(filtered.map((c) => c.divYield5YAvg)),
      withYieldCount: withYield.length,
      nonPayers,
      scatterYield: filtered
        .filter(
          (c) =>
            c.peRatio != null &&
            !Number.isNaN(c.peRatio) &&
            c.dividendYield != null &&
            !Number.isNaN(c.dividendYield)
        )
        .slice(0, 80),
    };
  }, [filtered]);

  const dividendSharpeLeaders = useMemo(
    () =>
      [...filtered]
        .filter((c) => c.sharpeRatio != null && !Number.isNaN(c.sharpeRatio))
        .sort((a, b) => b.sharpeRatio - a.sharpeRatio)
        .slice(0, 10),
    [filtered]
  );

  const roeDeScatter = useMemo(
    () =>
      filtered.filter(
        (c) =>
          c.debtEquity != null &&
          !Number.isNaN(c.debtEquity) &&
          c.roe != null &&
          !Number.isNaN(c.roe)
      ),
    [filtered]
  );

  const sectorData = useMemo(() => buildSectorRollup(filtered), [filtered]);
  const countryData = useMemo(() => buildCountryRollup(filtered), [filtered]);
  const countryDetail = useMemo(() => countryData.find(c => c.country === country) || countryData[0] || {}, [countryData, country]);
  const countryCompanies = useMemo(() => filtered.filter(c => c.country === country), [filtered, country]);
  const wfItems = useMemo(() => buildWaterfall(filtered, country), [filtered, country]);

  const selectedCompany = useMemo(() => {
    if (companyId === null) return null;
    return countryCompanies.find(c => c.id === companyId) || null;
  }, [companyId, countryCompanies]);

  useEffect(() => {
    if (!selectedCompany?.symbol) return;
    let cancelled = false;
    const cid = selectedCompany.id;
    const sym = selectedCompany.symbol;

    const load = async () => {
      try {
        const res = await getStockData(sym);
        if (cancelled) return;
        const hist = normalizeChart(res.chart || []);
        setData((prev) =>
          prev.map((c) =>
            c.id === cid
              ? { ...mergeApiMetricsToCompany(c, res.metrics), priceHistory: hist }
              : c
          )
        );
      } catch {
        /* keep last good row */
      }
    };

    load();
    const id = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedCompany?.id, selectedCompany?.symbol]);

  useEffect(() => {
    if (!modalCompany?.symbol) {
      modalSymRef.current = "";
      return;
    }
    if (modalSymRef.current === modalCompany.symbol && modalCompany.priceHistory?.length) return;
    modalSymRef.current = modalCompany.symbol;
    let cancelled = false;
    const sym = modalCompany.symbol;
    (async () => {
      try {
        const res = await getStockData(sym);
        if (cancelled) return;
        setModalCompany((prev) =>
          prev && prev.symbol === sym
            ? { ...mergeApiMetricsToCompany(prev, res.metrics), priceHistory: normalizeChart(res.chart || []) }
            : prev
        );
      } catch {
        /* keep modal row as opened */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modalCompany]);

  const companyCandidates = useMemo(() => {
    const q = companyQuery.trim().toLowerCase();
    const base = [...countryCompanies].sort((a, b) => b.capitalGravity - a.capitalGravity);
    const list = q ? base.filter(c => c.name.toLowerCase().includes(q)) : base;
    return list.slice(0, 60);
  }, [countryCompanies, companyQuery]);

  const companyWfItems = useMemo(() => selectedCompany ? buildCompanyWaterfall(selectedCompany) : null, [selectedCompany]);
  const companySeries = useMemo(() => {
    if (!selectedCompany) return null;
    if (selectedCompany.priceHistory?.length) return selectedCompany.priceHistory;
    return buildCompanySeries(selectedCompany, 50);
  }, [selectedCompany]);

  // Aggregates
  const totalCap = filtered.reduce((a, c) => a + c.capitalGravity, 0);
  const totalRev = filtered.reduce((a, c) => a + c.revenueFlow, 0);
  const avgVal = filtered.reduce((a, c) => a + c.valuationIndex, 0) / (filtered.length || 1);
  const posGrowth = filtered.filter(c => c.growthMomentum > 0).length;

  // Visual enhancements
  const sp1 = Array.from({ length: 20 }, (_, i) => 2800 + Math.sin(i * .7) * 200 + rnd(-80, 80));
  const sp2 = Array.from({ length: 20 }, (_, i) => totalRev / 18 + Math.sin(i * .5) * 200 + rnd(-80, 80));
  const sp3 = Array.from({ length: 20 }, (_, i) => avgVal + Math.sin(i * .9) * 8 + rnd(-4, 4));

  const TABS = [
    { id: "global", label: "Global Overview" },
    { id: "sectors", label: "Sector Intelligence" },
    { id: "country", label: "Country Analysis" },
    { id: "portfolio", label: "Portfolio Builder" },
    { id: "peers", label: "Peer Comparison" },
    { id: "risk", label: "Risk & Correlation" },
    { id: "history", label: "Historical Trends" },
    { id: "dividend", label: "Dividend & Yield" },
    { id: "stocklab", label: "Stock Analysis" },
    { id: "montecarlo", label: "Monte Carlo" },
    { id: "technical", label: "Technical Indicators" },
  ];

  // Keyboard navigation
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const idx = parseInt(e.key) - 1;
      if (idx >= 0 && idx < TABS.length) setTab(TABS[idx].id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Watchlist helpers
  const toggleWatch = (id) => {
    setWatchlist(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };
  const watchedCompanies = useMemo(() => data.filter(c => watchlist.includes(c.id)), [data, watchlist]);

  const exportWatchlistCsv = () => {
    if (!watchedCompanies.length) return;
    const esc = (v) => {
      if (v == null || v === "") return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = "Symbol,Name,Country,Sector,Price,PE,DivYield,Beta";
    const lines = watchedCompanies.map((c) =>
      [c.symbol, esc(c.name), esc(c.country), esc(c.sector), esc(c.sharePrice), esc(c.peRatio), esc(c.dividendYield), esc(c.beta)].join(",")
    );
    downloadTextFile("meridian-watchlist.csv", [header, ...lines].join("\n"));
  };

  // Anomaly detection
  const anomalies = useMemo(() => {
    const avgRisk = filtered.reduce((a, c) => a + c.riskCoefficient, 0) / (filtered.length || 1);
    const stdRisk = Math.sqrt(filtered.reduce((a, c) => a + Math.pow(c.riskCoefficient - avgRisk, 2), 0) / (filtered.length || 1));
    return new Set(filtered.filter(c => c.riskCoefficient > avgRisk + 1.5 * stdRisk || c.growthMomentum < -5).map(c => c.id));
  }, [filtered]);

  // Sorted leaderboard
  const sortedFiltered = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      const aNum = av == null || Number.isNaN(av) ? 0 : av;
      const bNum = bv == null || Number.isNaN(bv) ? 0 : bv;
      return sortDir === 'desc' ? bNum - aNum : aNum - bNum;
    });
    return arr;
  }, [filtered, sortCol, sortDir]);
  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  // Market summary auto-generator
  const marketSummary = useMemo(() => {
    if (!filtered.length) return '';
    const topSector = sectorData[0]?.sector || 'N/A';
    const topCountry = countryData[0]?.country || 'N/A';
    const avgPE = (filtered.reduce((a, c) => a + c.peRatio, 0) / filtered.length).toFixed(1);
    const avgBeta = (filtered.reduce((a, c) => a + c.beta, 0) / filtered.length).toFixed(2);
    const highRiskPct = ((filtered.filter(c => c.riskCoefficient > 60).length / filtered.length) * 100).toFixed(0);
    const bullish = filtered.filter(c => c.growthMomentum > 10).length;
    return `The market tracks ${filtered.length} entities across ${COUNTRIES.length} economies. ${topSector} leads in capital gravity, while ${topCountry} dominates sovereign holdings. Average P/E sits at ${avgPE}x with a market Beta of ${avgBeta}. ${highRiskPct}% of entities are in the high-risk zone (>60). ${bullish} companies show strong bullish momentum (>10% growth). ${anomalies.size} entities flagged as anomalous based on risk/growth deviation.`;
  }, [filtered, sectorData, countryData, COUNTRIES.length, anomalies.size]);

  // Historical trend (6-month simulated)
  const historicalSeries = useMemo(() => {
    return Array.from({ length: 180 }, (_, i) => {
      const day = i + 1;
      const base = 4500 + Math.sin(i / 30) * 300 + Math.sin(i / 7) * 80 + i * 1.5;
      const ma20 = i >= 20 ? base - rnd(-30, 30) : null;
      const ma50 = i >= 50 ? base - rnd(-60, 60) + 50 : null;
      return { day, label: `D${day}`, Index: base + rnd(-40, 40), MA20: ma20, MA50: ma50 };
    });
  }, []);

  // Sector momentum heatmap data
  const sectorHeatData = useMemo(() => {
    return Array.from({ length: 7 }, () => Array.from({ length: 12 }, () => ({ value: rnd(5, 95) })));
  }, []);

  // Global search results
  const globalSearchResults = useMemo(() => {
    if (!globalSearch.trim()) return [];
    const q = globalSearch.toLowerCase();
    return data.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [data, globalSearch]);

  // Monte Carlo simulation (1000 runs × 60 days)
  const monteCarlo = useMemo(() => {
    const runs = 200, days = 60, startVal = 100;
    const paths = [];
    const finalVals = [];
    for (let r = 0; r < runs; r++) {
      let val = startVal;
      const path = [{ day: 0, val }];
      for (let d = 1; d <= days; d++) {
        val *= (1 + rnd(-0.04, 0.045));
        path.push({ day: d, val });
      }
      paths.push(path);
      finalVals.push(val);
    }
    finalVals.sort((a, b) => a - b);
    const buckets = Array.from({ length: 20 }, (_, i) => {
      const lo = 60 + i * 4, hi = lo + 4;
      return { range: `${lo}-${hi}`, count: finalVals.filter(v => v >= lo && v < hi).length, lo, hi };
    });
    const var5 = finalVals[Math.floor(runs * 0.05)];
    const median = finalVals[Math.floor(runs * 0.5)];
    const mean = finalVals.reduce((a, v) => a + v, 0) / runs;
    // Pick 15 sample paths to display
    const samplePaths = paths.filter((_, i) => i % Math.floor(runs / 15) === 0).slice(0, 15);
    return { buckets, var5, median, mean, samplePaths, paths };
  }, []);

  // Technical indicators (180-day simulated)
  const techData = useMemo(() => {
    const prices = historicalSeries.map(d => d.Index);
    return historicalSeries.map((d, i) => {
      // RSI (14-period)
      let rsi = 50;
      if (i >= 14) {
        let gains = 0, losses = 0;
        for (let j = i - 13; j <= i; j++) {
          const diff = prices[j] - prices[j - 1];
          if (diff > 0) gains += diff; else losses -= diff;
        }
        const rs = gains / (losses || 1);
        rsi = 100 - 100 / (1 + rs);
      }
      // Bollinger (20-period)
      let bb_upper = d.Index, bb_lower = d.Index, sma20 = d.Index;
      if (i >= 20) {
        const slice = prices.slice(i - 20, i);
        sma20 = slice.reduce((a, v) => a + v, 0) / 20;
        const std = Math.sqrt(slice.reduce((a, v) => a + Math.pow(v - sma20, 2), 0) / 20);
        bb_upper = sma20 + 2 * std; bb_lower = sma20 - 2 * std;
      }
      // MACD (12-EMA minus 26-EMA simplified)
      const ema12 = i >= 12 ? prices.slice(i - 12, i).reduce((a, v) => a + v, 0) / 12 : prices[i];
      const ema26 = i >= 26 ? prices.slice(i - 26, i).reduce((a, v) => a + v, 0) / 26 : prices[i];
      const macd = ema12 - ema26;
      const signal = macd * 0.8 + rnd(-5, 5); // simplified signal
      return { ...d, RSI: rsi, BB_Upper: bb_upper, BB_Lower: bb_lower, SMA20: sma20, MACD: macd, Signal: signal, Histogram: macd - signal };
    });
  }, [historicalSeries]);

  // Sector rotation lifecycle
  const sectorRotation = useMemo(() => {
    const phases = ['Early Recovery', 'Expansion', 'Late Cycle', 'Recession'];
    return sectorData.slice(0, 8).map((s) => {
      const growth = filtered.filter(c => c.sector === s.sector).reduce((a, c) => a + c.growthMomentum, 0) / (filtered.filter(c => c.sector === s.sector).length || 1);
      const phase = growth > 20 ? 0 : growth > 10 ? 1 : growth > 0 ? 2 : 3;
      return { ...s, phase, phaseName: phases[phase], avgGrowth: growth };
    });
  }, [sectorData, filtered]);

  // Sector ETF simulation
  const sectorETFs = useMemo(() => {
    return sectorData.slice(0, 6).map(s => {
      const series = Array.from({ length: 90 }, (_, d) => ({
        day: d + 1,
        label: `D${d + 1}`,
        value: 100 + Math.sin(d / 15) * 8 + d * rnd(-0.05, 0.15) + rnd(-3, 3),
      }));
      return { sector: s.sector, color: s.color, series, expense: rnd(0.02, 0.8).toFixed(2) };
    });
  }, [sectorData]);

  // Achievements
  const achievements = useMemo(() => [
    { id: 'first_watch', icon: '⭐', title: 'First Watch', desc: 'Add your first company to the watchlist', unlocked: watchlist.length >= 1 },
    { id: 'watchlist_5', icon: '🔭', title: 'Market Watcher', desc: 'Watch 5 or more companies', unlocked: watchlist.length >= 5 },
    { id: 'portfolio_start', icon: '💼', title: 'Portfolio Pioneer', desc: 'Allocate capital in portfolio builder', unlocked: Object.values(portfolio).some(v => v > 0) },
    { id: 'peer_compare', icon: '⚖️', title: 'Analyst Mode', desc: 'Compare 2+ companies as peers', unlocked: peerIds.length >= 2 },
    { id: 'sector_explorer', icon: '🔍', title: 'Sector Explorer', desc: 'Filter by a specific sector', unlocked: sector !== 'All' },
    { id: 'country_deep', icon: '🌍', title: 'Global Navigator', desc: 'Explore country-level analysis', unlocked: tab === 'country' || tab === 'portfolio' },
    { id: 'risk_hunter', icon: '🎯', title: 'Risk Hunter', desc: `${anomalies.size} anomalies detected`, unlocked: anomalies.size > 0 },
    { id: 'data_master', icon: '📊', title: 'Data Master', desc: 'Explore all dashboard tabs', unlocked: false },
  ], [watchlist, portfolio, peerIds, sector, tab, anomalies]);



  // ─── PORTFOLIO DERIVED ────────────────────────────────────
  const portfolioEntries = useMemo(() => {
    return Object.entries(portfolio)
      .map(([idStr, alloc]) => ({ company: data.find(c => c.id === Number(idStr)), alloc }))
      .filter(e => e.company && e.alloc > 0);
  }, [portfolio, data]);

  const portfolioTotalAlloc = portfolioEntries.reduce((a, e) => a + e.alloc, 0);

  const portfolioStats = useMemo(() => {
    if (!portfolioEntries.length) return null;
    const wtdGrowth = portfolioEntries.reduce((a, e) => a + e.company.growthMomentum * (e.alloc / 100), 0);
    const wtdRisk = portfolioEntries.reduce((a, e) => a + e.company.riskCoefficient * (e.alloc / 100), 0);
    const wtdLiquidity = portfolioEntries.reduce((a, e) => a + e.company.liquidityScore * (e.alloc / 100), 0);
    const wtdValuation = portfolioEntries.reduce((a, e) => a + e.company.valuationIndex * (e.alloc / 100), 0);
    const wtdYield = portfolioEntries.reduce((a, e) => a + e.company.efficiencyRatio * (e.alloc / 100), 0);
    return { wtdGrowth, wtdRisk, wtdLiquidity, wtdValuation, wtdYield };
  }, [portfolioEntries]);

  const portfolioSeries = useMemo(() => {
    if (!portfolioEntries.length) return [];
    return Array.from({ length: 50 }, (_, i) => {
      let price = 100;
      portfolioEntries.forEach(e => {
        const base = e.company.sharePrice;
        const amp = Math.max(10, base * 0.04);
        const drift = (e.company.growthMomentum || 0) / 50;
        const val = base + Math.sin(i / 6) * amp + Math.sin(i / 11) * amp * 0.4 + drift * i * 10;
        price += (val / base - 1) * e.alloc;
      });
      return { i: i + 1, label: `D${i + 1}`, Value: price };
    });
  }, [portfolioEntries]);

  // ─── PEER DERIVED ─────────────────────────────────────────
  const peerCompanies = useMemo(() => {
    return peerIds.map(id => data.find(c => c.id === id)).filter(Boolean);
  }, [peerIds, data]);

  const peerSearchResults = useMemo(() => {
    const q = peerSearch.trim().toLowerCase();
    if (!q) return [];
    return [...filtered].sort((a, b) => b.capitalGravity - a.capitalGravity)
      .filter(c => c.name.toLowerCase().includes(q) && !peerIds.includes(c.id))
      .slice(0, 8);
  }, [peerSearch, filtered, peerIds]);

  const peerRadarData = useMemo(() => {
    if (!peerCompanies.length) return [];
    const metrics = ['growthMomentum', 'liquidityScore', 'riskCoefficient', 'valuationIndex', 'efficiencyRatio'];
    const labels = ['Growth', 'Liquidity', 'Risk', 'Valuation', 'Efficiency'];
    const maxes = metrics.map(m => Math.max(...peerCompanies.map(c => Math.abs(c[m])), 1));
    return labels.map((label, mi) => {
      const row = { metric: label };
      peerCompanies.forEach((c, ci) => { row[`c${ci}`] = Math.abs(c[metrics[mi]]) / maxes[mi] * 100; });
      return row;
    });
  }, [peerCompanies]);

  // ─── RISK DERIVED ─────────────────────────────────────────
  const riskBuckets = useMemo(() => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ range: `${i * 10}-${i * 10 + 10}`, count: 0, color: i < 3 ? P.emerald : i < 6 ? P.amber : P.rose }));
    filtered.forEach(c => { const idx = Math.min(Math.floor((c.riskCoefficient ?? 0) / 10), 9); buckets[idx].count++; });
    return buckets;
  }, [filtered]);

  const sectorRisk = useMemo(() => {
    return sectorData.map(s => {
      const companies = filtered.filter(c => c.sector === s.sector);
      const avgRisk = companies.reduce((a, c) => a + c.riskCoefficient, 0) / (companies.length || 1);
      return { ...s, avgRisk };
    }).sort((a, b) => b.avgRisk - a.avgRisk);
  }, [sectorData, filtered]);

  // Ticker data (must be before early return — hooks order)
  const tickerItems = useMemo(() => sortedFiltered.slice(0, 30), [sortedFiltered]);

  if (!data.length && dataLoading) {
    return <MeridianLoadingScreen />;
  }

  if (!data.length && dataError) {
    return (
      <>
        <ParticleCanvas />
        <div style={{
          position: "fixed", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", zIndex: 10, background: "#080c14"
        }}>
          <div style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(232,184,75,0.25)",
            borderRadius: 24,
            padding: "48px 56px",
            maxWidth: 440,
            width: "90%",
            textAlign: "center",
            backdropFilter: "blur(24px)",
            boxShadow: "0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)"
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: "50%",
              background: "rgba(239,68,68,0.12)",
              border: "2px solid rgba(239,68,68,0.4)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 24px", fontSize: 32
            }}>⚠</div>
            <div style={{ color: "#f87171", fontSize: 18, fontWeight: 700, marginBottom: 10, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              Connection Failed
            </div>
            <div style={{ color: P.slateD, fontSize: 13, lineHeight: 1.7, marginBottom: 28, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              Unable to reach the market data API. Make sure the backend server is running on port 5000.
            </div>
            <div style={{ color: "rgba(148,163,184,0.55)", fontSize: 11, fontFamily: "'DM Mono', monospace", background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 28, textAlign: "left", lineHeight: 1.8 }}>
              <span style={{ color: P.gold }}>$</span> cd backend<br />
              <span style={{ color: P.gold }}>$</span> python app.py
            </div>
            <button
              type="button"
              style={{
                background: "linear-gradient(135deg, #e8b84b, #d4973a)",
                color: "#080c14",
                border: "none",
                borderRadius: 12,
                padding: "14px 36px",
                fontSize: 14,
                fontWeight: 700,
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                cursor: "pointer",
                letterSpacing: ".06em",
                transition: "opacity .2s, transform .2s",
                boxShadow: "0 8px 24px rgba(232,184,75,0.35)"
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = "0.88"; e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "translateY(0)"; }}
              onClick={() => {
                setDataError(null);
                setReloadTick((t) => t + 1);
              }}
            >
              Retry Connection
            </button>
          </div>
        </div>
      </>
    );
  }

  if (!data.length) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: P.slateD }}>
        No market data available.
      </div>
    );
  }

  return (
    <>
      <ParticleCanvas />

      {/* ═══ COMPANY DEEP DIVE MODAL ═══ */}
      {modalCompany && (
        <div className="modal-overlay" onClick={() => setModalCompany(null)}>
          <div className="modal-content modal-lux" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModalCompany(null)}>✕</button>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
              <CompanyLogo company={modalCompany} size={52} radius={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ color: P.white, fontSize: 22, fontWeight: 700, fontFamily: "'Playfair Display',serif", margin: 0 }}>{modalCompany.name}</h2>
                <div style={{ fontSize: 12, color: P.slateD, marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="badge" style={{ background: SECTOR_COLORS[modalCompany.sector] + "22", color: SECTOR_COLORS[modalCompany.sector] }}>{modalCompany.sector}</span>
                  <CountryFlag country={modalCompany.country} size={18} />
                  <span>{modalCompany.country}</span>
                  <span style={{ fontFamily: "DM Mono, monospace", opacity: 0.85 }}>{modalCompany.symbol}</span>
                </div>
              </div>
              {anomalies.has(modalCompany.id) && <span style={{ fontSize: 10, background: "rgba(251,113,133,.15)", color: P.rose, padding: "4px 10px", borderRadius: 12, fontWeight: 700 }}>⚠ ANOMALY</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 24 }}>
                {[
                  { l: "Capital", v: (modalCompany.capitalGravity == null || Number.isNaN(modalCompany.capitalGravity)) ? "N/A" : fmtUsdBn(modalCompany.capitalGravity), c: P.gold }, { l: "Revenue", v: (modalCompany.revenueFlow == null || Number.isNaN(modalCompany.revenueFlow)) ? "N/A" : fmtUsdBn(modalCompany.revenueFlow), c: P.sky },
                  { l: "Price", v: fmtLocalPrice(modalCompany.sharePrice, modalCompany.currency), c: P.amber },
                  { l: "P/E", v: `${fmtNum(modalCompany.peRatio, 1, "x")}`, c: P.amber }, { l: "P/B", v: `${fmtNum(modalCompany.pbRatio, 2, "x")}`, c: P.sky },
                  { l: "D/E", v: fmtNum(modalCompany.debtEquity, 2), c: (modalCompany.debtEquity ?? 0) > 2 ? P.rose : P.slate }, { l: "ROE", v: `${fmtNum(modalCompany.roe, 1, "%")}`, c: (modalCompany.roe ?? 0) > 15 ? P.emerald : P.slate },
                  { l: "ROA", v: `${fmtNum(modalCompany.roa, 1, "%")}`, c: P.sky }, { l: "Beta", v: fmtNum(modalCompany.beta, 2), c: (modalCompany.beta ?? 0) > 1.5 ? P.rose : P.emerald },
                  { l: "Sharpe", v: fmtNum(modalCompany.sharpeRatio, 2), c: (modalCompany.sharpeRatio ?? 0) > 1.5 ? P.emerald : P.amber }, { l: "EBITDA %", v: `${fmtNum(modalCompany.ebitdaMargin, 1, "%")}`, c: P.emerald },
                  { l: "Div Yield", v: `${fmtNum(modalCompany.dividendYield, 2, "%")}`, c: P.gold }, { l: "FCF Yield", v: `${fmtNum(modalCompany.fcfYield, 2, "%")}`, c: P.sky },
                  { l: "Growth", v: `${(modalCompany.growthMomentum ?? 0) > 0 ? "+" : ""}${fmtNum(modalCompany.growthMomentum, 1, "%")}`, c: (modalCompany.growthMomentum ?? 0) > 0 ? P.emerald : P.rose },
                  { l: "Risk", v: fmtNum(modalCompany.riskCoefficient, 0), c: (modalCompany.riskCoefficient ?? 0) > 60 ? P.rose : P.amber },
                  { l: "Liquidity", v: fmtNum(modalCompany.liquidityScore, 0), c: P.sky }, { l: "Efficiency", v: `${fmtNum((modalCompany.efficiencyRatio ?? 0) * 100, 1, "%")}`, c: P.emerald },
                ].map((m, i) => (
                <div key={i} className="card-flat metric-tile-micro" style={{ padding: "10px 12px", textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: P.slateD, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4 }}>{m.l}</div>
                  <div style={{ fontFamily: "DM Mono", fontSize: 16, color: m.c, fontWeight: 600 }}>{m.v}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <div className="clabel">ESG Profile</div>
                <ResponsiveContainer width="100%" height={200}>
                  <RadarChart data={[{ m: "Environmental", v: modalCompany.esgEnv }, { m: "Social", v: modalCompany.esgSoc }, { m: "Governance", v: modalCompany.esgGov }]}>
                    <PolarGrid stroke="rgba(255,255,255,.08)" />
                    <PolarAngleAxis dataKey="m" tick={{ fill: P.slateD, fontSize: 11 }} />
                    <PolarRadiusAxis tick={false} axisLine={false} domain={[0, 100]} />
                    <Radar dataKey="v" name="Score" stroke={P.emerald} fill={P.emerald} fillOpacity={.2} strokeWidth={2} />
                    <Tooltip content={<TT />} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <div className="clabel">50-Day Price Trend</div>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={modalCompany.priceHistory?.length ? modalCompany.priceHistory : buildCompanySeries(modalCompany, 50)} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                    <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: P.slateD, fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<TT />} />
                    <Area type="monotone" dataKey="Price" stroke={P.gold} fill={P.gold} fillOpacity={.15} strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ TICKER TAPE ═══ */}
      <div className="ticker-wrap">
        <div className="ticker-track">
          {[...tickerItems, ...tickerItems].map((c, i) => (
            <span key={i} className="ticker-item ticker-item-rich">
              <CompanyLogo company={c} size={18} radius={6} />
              <span className="name">{c.name}</span>
              <CountryFlag country={c.country} size={14} title={c.country} />
              <span style={{ fontFamily: "DM Mono", color: P.gold }}>{fmtLocalPrice(c.sharePrice, c.currency)}</span>
              <span className={(c.growthMomentum ?? 0) > 0 ? "up" : "dn"}>{(c.growthMomentum ?? 0) > 0 ? "+" : ""}{fmtNum(c.growthMomentum, 1, '%')}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="root" style={{ position: "relative", zIndex: 1 }}>
        {/* ═══ HEADER ════════════════════════════════════════════════════════ */}
        <div style={{ padding: "22px 0 0" }} className="page-shell">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: "linear-gradient(135deg,#e8b84b,#f59e0b44)", border: "1px solid rgba(232,184,75,.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, boxShadow: "0 0 28px rgba(232,184,75,.3)" }}>◈</div>
                <div>
                  <h1 style={{ fontFamily: "'Playfair Display',serif", fontSize: "clamp(20px,3vw,28px)", fontWeight: 700, color: P.white, letterSpacing: "-.01em", lineHeight: 1 }}>
                    Meridian <span style={{ color: P.gold }}>Analytics</span>
                  </h1>
                  <div style={{ fontSize: 12, color: P.slateD, letterSpacing: ".12em", textTransform: "uppercase", marginTop: 3, fontWeight: 600 }}>Global Capital Intelligence Platform</div>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              {/* User Controls */}
              {user && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginRight: 16 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <span style={{ fontSize: 13, color: P.white, fontWeight: 600 }}>{user.name}</span>
                    <span style={{ fontSize: 10, color: P.slateD, textTransform: 'uppercase', letterSpacing: '1px' }}>{user.email}</span>
                  </div>
                  <button onClick={onLogout} style={{ background: "rgba(251,113,133,0.1)", color: P.rose, border: `1px solid ${P.rose}40`, padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: "bold", cursor: "pointer", textTransform: "uppercase", letterSpacing: "1px", transition: "all 0.2s" }} onMouseEnter={e => { e.currentTarget.style.background = P.rose; e.currentTarget.style.color = P.bg; }} onMouseLeave={e => { e.currentTarget.style.background = "rgba(251,113,133,0.1)"; e.currentTarget.style.color = P.rose; }}>Logout</button>
                </div>
              )}

              {/* Global Search */}
              <div className="search-wrap">
                <span className="search-icon">🔍</span>
                <input className="search-box" placeholder="Search any company…" value={globalSearch}
                  onChange={e => setGlobalSearch(e.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setTimeout(() => setSearchFocused(false), 200)} />
                {searchFocused && globalSearchResults.length > 0 && (
                  <div className="search-results">
                    {globalSearchResults.map(c => (
                      <div key={c.id} className="search-results-item micro-list-item" onClick={() => { setModalCompany(c); setGlobalSearch(''); setSearchFocused(false); }}>
                        <CompanyLogo company={c} size={30} radius={8} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: P.white, fontWeight: 600 }}>{c.name}</span>
                          <div style={{ fontSize: 11, color: P.slateD, marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <CountryFlag country={c.country} size={14} />
                            <span>{c.country}</span>
                            <span style={{ fontFamily: "DM Mono, monospace" }}>{c.symbol}</span>
                          </div>
                          <div style={{ fontSize: 10, color: P.slateD, marginTop: 4 }}>{c.sector} · {fmtUsdBn(c.capitalGravity)} mcap (USD)</div>
                        </div>
                        <span style={{ fontFamily: "DM Mono", color: P.gold, fontSize: 12 }}>{fmtLocalPrice(c.sharePrice, c.currency)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
              <Gauge value={live.vol} max={100} color={P.sky} label="Volume" size={86} />
              <Gauge value={live.momentum} max={100} color={P.emerald} label="Momentum" size={86} />
              <Gauge value={live.heat} max={100} color={P.rose} label="Volatility" size={86} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 28, color: P.gold, fontWeight: 500 }}>{live.gi.toLocaleString()}</div>
                <div style={{ fontSize: 11, color: P.slateD, letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 600, marginTop: 2 }}>Global Index</div>
                <div style={{ marginTop: 5, display: "flex", justifyContent: "center" }}><div className="dot" /></div>
              </div>
            </div>
          </div>

          {/* NAV */}
          <div className="nav-tab-rail" style={{ borderBottom: `1px solid ${P.border}`, paddingBottom: 14 }}>
            {TABS.map(t => (
              <button key={t.id} className={`nav-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
            <div style={{ flex: 1 }} />
            <select className="sel" value={sector} onChange={e => setSector(e.target.value)}>
              <option value="All">All Sectors</option>
              {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* ═══ CONTENT ═══════════════════════════════════════════════════════ */}
        <div style={{ flex: 1, padding: "20px 0 40px", display: "flex", flexDirection: "column", gap: 20 }} className="page-shell">

          {/* ░░ GLOBAL OVERVIEW ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "global" && (
            <>
              {/* KPIs */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(185px,1fr))", gap: 14 }}>
                {[
                  { label: "Capital Gravity", value: fmtUsdBn(totalCap / 1000), delta: "+4.2%", up: true, spark: sp1, color: P.gold, note: "USD" },
                  { label: "Revenue Flow",    value: fmtUsdBn(totalRev / 1000), delta: "+1.9%", up: true, spark: sp2, color: P.sky,  note: "USD" },
                  { label: "Valuation Index", value: `${avgVal.toFixed(1)}x`,   delta: "-0.3%", up: false, spark: sp3, color: P.violet, note: null },
                  { label: "Growth Engines",  value: posGrowth,                 delta: `of ${filtered.length}`, up: true, spark: null, color: P.emerald, note: null },
                  { label: "Economies Covered", value: COUNTRIES.length, delta: "Nations",  up: null, spark: null, color: P.amber, note: null },
                  { label: "Sector Segments",   value: SECTORS.length,  delta: "Segments", up: null, spark: null, color: P.rose, note: null },
                ].map((k, i) => (
                  <div key={i} className="card-lux fu" style={{ animationDelay: `${i * .05}s` }}>
                    <div className="kl">{k.label}{k.note && <span style={{ fontSize: 9, color: P.slateD, marginLeft: 6, letterSpacing: '.06em' }}>{k.note}</span>}</div>
                    <div className="kv" style={{ color: k.color, fontSize: 24 }}>{k.value}</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                      <span className={`kd ${k.up === true ? "up" : k.up === false ? "dn" : "nt"}`}>{k.up === true ? "▲ " : k.up === false ? "▼ " : ""}{k.delta}</span>
                      {k.spark && <Spark data={k.spark} color={k.color} />}
                    </div>
                  </div>
                ))}
              </div>

              {/* Treemap + Donut */}
              <div className="chart-split treemap-donut-row">
                <div className="card card-lux treemap-card">
                  <div className="clabel">Capital Distribution — Sector Treemap</div>
                  <ResponsiveContainer width="100%" height={300}>
                    <Treemap
                      data={sectorData.map((s) => ({ name: s.sector, size: safeNum(s.capitalGravity, 0), color: s.color }))}
                      dataKey="size"
                      aspectRatio={4 / 3}
                      stroke="transparent"
                      isAnimationActive={false}
                      content={TreemapSectorPremium}
                    />
                  </ResponsiveContainer>
                </div>
                <div className="card card-lux">
                  <div className="clabel">Revenue Flow by Sector</div>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={sectorData} dataKey="revenueFlow" nameKey="sector" cx="50%" cy="50%" innerRadius={65} outerRadius={100} paddingAngle={4}>
                        {sectorData.map((s, i) => (<Cell key={i} fill={s.color} fillOpacity={.82} stroke="rgba(0,0,0,.3)" strokeWidth={1} />))}
                      </Pie>
                      <Tooltip content={<TT />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "5px 12px", marginTop: 8 }}>
                    {sectorData.map(s => (<div key={s.sector} style={{ display: "flex", alignItems: "center", gap: 5 }}><div style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} /><span style={{ fontSize: 10, color: P.slateD }}>{s.sector}</span></div>))}
                  </div>
                </div>
              </div>

              {/* Country Bars + Scatter */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                <div className="card" style={{ padding: "22px" }}>
                  <div className="clabel">Sovereign Capital Gravity — Top Economies</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={countryData.slice(0, 8)} layout="vertical" margin={{ left: 100, right: 12 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="country" tick={{ fill: P.slate, fontSize: 13, fontFamily: "Plus Jakarta Sans", fontWeight: 500 }} tickLine={false} width={105} />
                      <Tooltip content={<TT />} />
                      <Bar dataKey="capitalGravity" name="Capital Gravity" radius={[0, 5, 5, 0]}>
                        {countryData.slice(0, 8).map((c, i) => (<Cell key={i} fill={c.color} fillOpacity={.78} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="card" style={{ padding: "22px" }}>
                  <div className="clabel">Growth Momentum × Liquidity — Economy Scatter</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <ScatterChart margin={{ left: 0, right: 10, top: 5 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="avgGrowth" name="Growth Momentum" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis dataKey="avgLiquidity" name="Liquidity Score" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <ZAxis dataKey="capitalGravity" range={[40, 300]} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload;
                        return <div style={{ background: "#111827", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "10px 14px", fontSize: 12 }}>
                          <div style={{ color: P.gold, fontWeight: 700 }}>{d?.country}</div>
                          <div style={{ color: P.slateD, marginTop: 4 }}>Growth: <span style={{ color: P.emerald, fontFamily: "DM Mono" }}>{d?.avgGrowth?.toFixed(1)}%</span></div>
                          <div style={{ color: P.slateD }}>Liquidity: <span style={{ color: P.sky, fontFamily: "DM Mono" }}>{d?.avgLiquidity?.toFixed(0)}</span></div>
                        </div>;
                      }} />
                      <ReferenceLine x={0} stroke="rgba(255,255,255,.1)" strokeDasharray="3 3" />
                      <Scatter data={countryData}>
                        {countryData.map((c, i) => (<Cell key={i} fill={c.color} fillOpacity={.8} />))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Market Intelligence Summary */}
              <div className="card fade-in" style={{ padding: "20px 24px" }}>
                <div className="clabel">Market Intelligence Summary</div>
                <p style={{ fontSize: 14, color: P.slate, lineHeight: 1.7, margin: 0 }}>{marketSummary}</p>
              </div>

              {/* Sortable Leaderboard */}
              <div className="card" style={{ padding: "22px" }}>
                <div className="clabel">Capital Gravity Leaderboard — Top Entities <span style={{ color: P.slateD, fontWeight: 400, fontSize: 10, marginLeft: 8 }}>Click headers to sort</span></div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${P.border}` }}>
                        {[
                          { label: "★", col: null }, { label: "Rank", col: null }, { label: "Entity", col: "name" }, { label: "Sector", col: null }, { label: "Capital", col: "capitalGravity" }, { label: "Revenue", col: "revenueFlow" }, { label: "P/E", col: "peRatio" }, { label: "Beta", col: "beta" }, { label: "Growth", col: "growthMomentum" }, { label: "Liquidity", col: "liquidityScore" },
                        ].map(h => (
                          <th key={h.label} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, color: sortCol === h.col ? P.gold : P.slateD, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", whiteSpace: "nowrap", cursor: h.col ? "pointer" : "default", transition: "color .2s" }}
                            onClick={() => h.col && handleSort(h.col)}>
                            {h.label}{sortCol === h.col ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedFiltered.slice(0, 20).map((c, i) => (
                        <tr key={c.id} className="trow">
                          <td style={{ padding: "8px 10px", cursor: "pointer", fontSize: 16 }} onClick={() => toggleWatch(c.id)}>
                            <span style={{ color: watchlist.includes(c.id) ? P.gold : P.slateD, transition: "color .2s" }}>{watchlist.includes(c.id) ? '★' : '☆'}</span>
                          </td>
                          <td style={{ padding: "8px 10px", color: P.slateD, fontFamily: "DM Mono", fontSize: 12 }}>{String(i + 1).padStart(2, "0")}</td>
                          <td style={{ padding: "8px 10px", color: P.white, fontWeight: 600, fontSize: 13 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
                              <CompanyLogo company={c} size={28} radius={8} />
                              <CountryFlag country={c.country} size={16} />
                              <span className="entity-link issuer-cell-name" onClick={() => setModalCompany(c)}>{c.name}</span>
                              {anomalies.has(c.id) && <span style={{ fontSize: 9, background: "rgba(251,113,133,.15)", color: P.rose, padding: "2px 6px", borderRadius: 10, fontWeight: 700 }}>⚠ ANOMALY</span>}
                            </div>
                          </td>
                          <td style={{ padding: "8px 10px" }}><span className="badge" style={{ background: SECTOR_COLORS[c.sector] + "18", color: SECTOR_COLORS[c.sector] }}>{c.sector}</span></td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono", color: P.gold, fontSize: 13 }}>$ {c.capitalGravity.toFixed(1)}B</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono", color: P.sky,  fontSize: 13 }}>$ {c.revenueFlow.toFixed(1)}B</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono", color: c.peRatio > 40 ? P.rose : P.amber, fontSize: 13 }}>{c.peRatio.toFixed(1)}x</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono", color: c.beta > 1.5 ? P.rose : c.beta < 0.8 ? P.emerald : P.slate, fontSize: 13 }}>{c.beta.toFixed(2)}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono", color: c.growthMomentum > 0 ? P.emerald : P.rose, fontSize: 13 }}>{c.growthMomentum > 0 ? "+" : ""}{c.growthMomentum.toFixed(1)}%</td>
                          <td style={{ padding: "8px 10px", minWidth: 90 }}><div className="prog"><div className="pfill" style={{ width: `${c.liquidityScore}%`, background: `linear-gradient(90deg,${P.sky}66,${P.sky})` }} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Watchlist Panel */}
              {watchedCompanies.length > 0 && (
                <div className="card scale-in" style={{ padding: "22px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
                    <div className="clabel" style={{ marginBottom: 0 }}>Your Watchlist — {watchedCompanies.length} Entities</div>
                    <button type="button" className="btn-export-csv" onClick={exportWatchlistCsv}>Export CSV</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
                    {watchedCompanies.map((c, i) => (
                      <div key={c.id} className="card-flat fu watchlist-card" style={{ padding: "14px 16px", animationDelay: `${i * .04}s`, borderLeft: `3px solid ${SECTOR_COLORS[c.sector]}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, gap: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                            <CompanyLogo company={c} size={32} radius={9} />
                            <div style={{ minWidth: 0 }}>
                              <span style={{ fontWeight: 600, fontSize: 13, color: P.white, display: "block" }}>{c.name}</span>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                                <CountryFlag country={c.country} size={14} />
                                <span style={{ fontSize: 10, color: P.slateD }}>{c.symbol}</span>
                              </div>
                            </div>
                          </div>
                          <span style={{ cursor: "pointer", color: P.gold, fontSize: 14, flexShrink: 0 }} onClick={() => toggleWatch(c.id)}>★</span>
                        </div>
                        <div style={{ fontSize: 11, color: P.slateD, marginBottom: 6 }}>{c.sector}</div>
                        <div style={{ display: "flex", gap: 12, fontSize: 12, fontFamily: "DM Mono" }}>
                          <span style={{ color: P.gold }}>${c.capitalGravity.toFixed(1)}B</span>
                          <span style={{ color: c.growthMomentum > 0 ? P.emerald : P.rose }}>{c.growthMomentum > 0 ? "+" : ""}{c.growthMomentum.toFixed(1)}%</span>
                          <span style={{ color: P.amber }}>PE {c.peRatio.toFixed(1)}</span>
                          <span style={{ color: P.sky }}>β {c.beta.toFixed(2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sector Momentum Heatmap */}
              <div className="card fade-in" style={{ padding: "22px" }}>
                <div className="clabel">Sector Momentum Heatmap — Weekly Activity</div>
                <HeatMap data={sectorHeatData} />
              </div>
            </>
          )}

          {/* ░░ SECTOR INTELLIGENCE ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "sectors" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 14 }}>
                {sectorData.map((s, i) => (
                  <div key={s.sector} className="card-flat fu" style={{ padding: "18px", animationDelay: `${i * .04}s`, borderLeft: `3px solid ${s.color}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13, color: P.white }}>{s.sector}</div>
                        <div style={{ fontSize: 10, color: P.slateD, marginTop: 2 }}>{s.count} entities</div>
                      </div>
                      <span className="badge" style={{ background: s.color + "18", color: s.color }}>{s.avgGrowth > 0 ? "▲" : "▼"} {Math.abs(s.avgGrowth).toFixed(1)}%</span>
                    </div>
                    {[
                      { label: "Capital Gravity", val: `${(s.capitalGravity / 1000).toFixed(2)}T`, pct: s.capitalGravity / 25000, color: P.gold },
                      { label: "Revenue Flow", val: `${s.revenueFlow.toFixed(0)}B`, pct: s.revenueFlow / 5000, color: P.sky },
                      { label: "Net Yield", val: `${s.netYield.toFixed(0)}B`, pct: s.netYield / 1500, color: P.emerald },
                      { label: "Avg Valuation", val: `${s.avgValuation.toFixed(1)}x`, pct: s.avgValuation / 100, color: P.violet },
                    ].map(row => (
                      <div key={row.label} style={{ marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 10, color: P.slateD, fontWeight: 500 }}>{row.label}</span>
                          <span style={{ fontSize: 11, color: row.color, fontFamily: "DM Mono", fontWeight: 500 }}>{row.val}</span>
                        </div>
                        <div className="prog"><div className="pfill" style={{ width: `${Math.min(row.pct * 100, 100)}%`, background: `linear-gradient(90deg,${row.color}55,${row.color})` }} /></div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ░░ COUNTRY ANALYSIS ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "country" && (
            <>
              <div className="mobile-country-bar" style={{ alignItems: "center", gap: 14 }}>
                <span style={{ fontWeight: 700, color: P.white, fontSize: 14 }}>Analyzing Economy:</span>
                <CountryFlag country={country} size={22} />
                <select className="sel" style={{ minWidth: 230, fontSize: 15, fontWeight: 600 }} value={country} onChange={e => setCountry(e.target.value)}>
                  {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className="inp" value={companyQuery} onChange={e => setCompanyQuery(e.target.value)} placeholder={`Search company in ${country}…`} />
                <select className="sel" style={{ minWidth: 320 }} value={companyId ?? ""} onChange={e => setCompanyId(e.target.value === "" ? null : Number(e.target.value))}>
                  <option value="">Economy view (all companies)</option>
                  {companyCandidates.map(c => (
                    <option key={c.id} value={c.id}>{c.name} — {c.sector}</option>
                  ))}
                </select>
                {selectedCompany && (
                  <span className="badge company-lens-badge" style={{ background: SECTOR_COLORS[selectedCompany.sector] + "18", color: SECTOR_COLORS[selectedCompany.sector], display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <CompanyLogo company={selectedCompany} size={22} radius={6} />
                    <CountryFlag country={selectedCompany.country} size={14} />
                    Company Lens: {selectedCompany.name}
                  </span>
                )}
              </div>

              {selectedCompany ? (
                <>
                  {/* Company KPIs */}
                  <div className="metric-card-grid" style={{ gap: 14 }}>
                    {[
                      { label: "Capital Gravity",  val: (selectedCompany.capitalGravity == null || Number.isNaN(selectedCompany.capitalGravity)) ? "N/A" : fmtUsdBn(selectedCompany.capitalGravity), color: P.gold },
                      { label: "Revenue Flow",     val: (selectedCompany.revenueFlow   == null || Number.isNaN(selectedCompany.revenueFlow))   ? "N/A" : fmtUsdBn(selectedCompany.revenueFlow),   color: P.sky  },
                      { label: "Net Yield",        val: (selectedCompany.netYield      == null || Number.isNaN(selectedCompany.netYield))      ? "N/A" : fmtUsdBn(selectedCompany.netYield),      color: P.emerald },
                      { label: "Valuation Index", val: fmtNum(selectedCompany.valuationIndex, 1, "x"), color: P.violet },
                      { label: "Share Price", val: (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: selectedCompany.priceHistory?.length ? "#22c55e" : "#6b7280", animation: selectedCompany.priceHistory?.length ? "pulse 2s infinite" : "none", flexShrink: 0 }} />
                          {fmtLocalPrice(selectedCompany.sharePrice, selectedCompany.currency)}
                        </span>
                      ), color: P.amber },
                      { label: "Growth Momentum", val: `${(selectedCompany.growthMomentum ?? 0) > 0 ? "+" : ""}${fmtNum(selectedCompany.growthMomentum, 1, "%")}`, color: (selectedCompany.growthMomentum ?? 0) > 0 ? P.emerald : P.rose },
                      { label: "Liquidity Score", val: fmtNum(selectedCompany.liquidityScore, 0), color: P.sky },
                      { label: "Risk Coefficient", val: fmtNum(selectedCompany.riskCoefficient, 0), color: P.rose },
                    ].map((k, i) => (
                      <div key={i} className="card fu" style={{ padding: "16px 18px", animationDelay: `${i * .04}s` }}>
                        <div className="kl">{k.label}</div>
                        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 20, fontWeight: 500, color: k.color, marginTop: 6 }}>{k.val}</div>
                      </div>
                    ))}
                  </div>

                  {/* Waterfall + Price Pulse */}
                  <div className="chart-split">
                    <div className="card" style={{ padding: "22px" }}>
                      <div className="clabel">Revenue Waterfall — {selectedCompany.name}</div>
                      <Waterfall items={companyWfItems || []} />
                    </div>
                    <div className="card" style={{ padding: "22px" }}>
                      <div className="clabel">Share Price Pulse — 50 Day</div>
                      <ResponsiveContainer width="100%" height={chartH}>
                        <LineChart data={companySeries || []} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
                          <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                          <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                          <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                          <Tooltip content={<TT />} />
                          <Line type="monotone" dataKey="Price" name="Share Price" stroke={P.gold} strokeWidth={2.5} dot={false} style={{ filter: `drop-shadow(0 0 4px ${P.gold}88)` }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Country KPIs */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 14 }}>
                    {[
                      { label: "Capital Gravity",  val: `${fmtUsdBn(countryDetail.capitalGravity / 1000)}`, color: P.gold },
                      { label: "Revenue Flow",     val: fmtUsdBn(countryDetail.revenueFlow),              color: P.sky  },
                      { label: "Net Yield",        val: fmtUsdBn(countryDetail.netYield),                 color: P.emerald },
                      { label: "Valuation Index", val: `${countryDetail.avgValuation.toFixed(1)}x`, color: P.violet },
                      { label: "Entities Tracked", val: countryDetail.count, color: P.slate },
                    ].map((k, i) => (
                      <div key={i} className="card fu" style={{ padding: "16px 18px", animationDelay: `${i * .04}s` }}>
                        <div className="kl">{k.label}</div>
                        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 20, fontWeight: 500, color: k.color, marginTop: 6 }}>{k.val}</div>
                      </div>
                    ))}
                  </div>

                  {/* Sector Pie + Waterfall */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                    <div className="card" style={{ padding: "22px" }}>
                      <div className="clabel">Sector Contribution — {country}</div>
                      <ResponsiveContainer width="100%" height={270}>
                        <PieChart>
                          <Pie data={SECTORS.map(s => ({ name: s, value: countryCompanies.filter(c => c.sector === s).reduce((a, c) => a + c.capitalGravity, 0) })).filter(d => d.value > 0)}
                            dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={3}>
                            {SECTORS.map((s, i) => (<Cell key={i} fill={SECTOR_COLORS[s]} fillOpacity={.82} stroke="rgba(0,0,0,.3)" strokeWidth={1} />))}
                          </Pie>
                          <Tooltip content={<TT />} />
                          <Legend wrapperStyle={{ fontFamily: "Plus Jakarta Sans", fontSize: 11, color: P.slateD }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="card" style={{ padding: "22px" }}>
                      <div className="clabel">Revenue Waterfall — {country}</div>
                      <Waterfall items={wfItems} />
                    </div>
                  </div>

                  {/* Top Entities Table */}
                  <div className="card" style={{ padding: "22px" }}>
                    <div className="clabel">Top Entities — {country}</div>
                    <div style={{ maxHeight: 270, overflowY: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead style={{ position: "sticky", top: 0, background: "#0d1220", zIndex: 1 }}>
                          <tr style={{ borderBottom: `1px solid ${P.border}` }}>
                            {["Entity", "Sector", "Capital", "Growth", "Liquidity"].map(h => (
                              <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, color: P.slateD, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {countryCompanies.sort((a, b) => b.capitalGravity - a.capitalGravity).slice(0, 14).map((c) => (
                            <tr key={c.id} className="trow">
                              <td style={{ padding: "9px 10px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                  <CompanyLogo company={c} size={26} radius={7} />
                                  <CountryFlag country={c.country} size={15} />
                                  <span style={{ color: P.white, fontWeight: 600, fontSize: 12, cursor: "pointer" }} onClick={() => setModalCompany(c)}>{c.name}</span>
                                </div>
                              </td>
                              <td style={{ padding: "9px 10px" }}><span className="badge" style={{ background: SECTOR_COLORS[c.sector] + "15", color: SECTOR_COLORS[c.sector] }}>{c.sector}</span></td>
                              <td style={{ padding: "9px 10px", fontFamily: "DM Mono", color: P.gold, fontSize: 11 }}>${c.capitalGravity.toFixed(1)}B</td>
                              <td style={{ padding: "9px 10px", fontFamily: "DM Mono", color: c.growthMomentum > 0 ? P.emerald : P.rose, fontSize: 11 }}>{c.growthMomentum > 0 ? "+" : ""}{c.growthMomentum.toFixed(1)}%</td>
                              <td style={{ padding: "9px 10px", minWidth: 80 }}><div className="prog"><div className="pfill" style={{ width: `${c.liquidityScore}%`, background: `linear-gradient(90deg,${P.sky}66,${P.sky})` }} /></div></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                </>
              )}
            </>
          )}

          {/* ░░ PORTFOLIO BUILDER ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "portfolio" && (
            <>
              <div className="fade-in" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <div style={{ fontSize: 14, color: P.slateD }}>
                  Build a simulated portfolio. Budget: <span style={{ color: P.gold, fontFamily: "DM Mono", fontSize: 16 }}>{portfolioBudget}%</span> — Allocated: <span style={{ color: portfolioTotalAlloc > 100 ? P.rose : P.emerald, fontFamily: "DM Mono", fontSize: 16 }}>{portfolioTotalAlloc.toFixed(0)}%</span>
                </div>
                <div style={{ flex: 1 }} />
                <CountryFlag country={portfolioCountry === "All" ? null : portfolioCountry} size={18} />
                <select className="sel" value={portfolioCountry} onChange={e => { setPortfolioCountry(e.target.value); setPortfolio({}); }}>
                  <option value="All">All Countries</option>
                  {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                {/* Company Selector + Sliders */}
                <div className="card slide-in-left" style={{ padding: "22px", maxHeight: 480, overflowY: "auto" }}>
                  <div className="clabel">Allocate Capital</div>
                  {[...(portfolioCountry === "All" ? filtered : filtered.filter(c => c.country === portfolioCountry))].sort((a, b) => b.capitalGravity - a.capitalGravity).slice(0, 30).map((c, i) => {
                    const alloc = portfolio[c.id] || 0;
                    return (
                      <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, animationDelay: `${i * .02}s` }} className="fu portfolio-alloc-row">
                        <CompanyLogo company={c} size={28} radius={8} />
                        <CountryFlag country={c.country} size={15} />
                        <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: P.white, fontWeight: 500 }}>{c.name}</div>
                        <input type="range" className="alloc-slider" min={0} max={40} step={1} value={alloc}
                          onChange={e => setPortfolio(p => ({ ...p, [c.id]: Number(e.target.value) }))} />
                        <div style={{ width: 40, textAlign: "right", fontFamily: "DM Mono", fontSize: 14, color: alloc > 0 ? P.gold : P.slateD }}>{alloc}%</div>
                      </div>
                    );
                  })}
                </div>

                {/* Allocation Pie */}
                <div className="card slide-in-right" style={{ padding: "22px" }}>
                  <div className="clabel">Portfolio Allocation</div>
                  {portfolioEntries.length > 0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={260}>
                        <PieChart>
                          <Pie data={portfolioEntries.map((e) => ({ name: e.company.name, value: e.alloc }))} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={3}>
                            {portfolioEntries.map((e, i) => (<Cell key={i} fill={ACCENT[i % ACCENT.length]} fillOpacity={.85} />))}
                          </Pie>
                          <Tooltip content={<TT />} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "5px 12px", marginTop: 8 }}>
                        {portfolioEntries.map((e, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <CompanyLogo company={e.company} size={18} radius={5} />
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: ACCENT[i % ACCENT.length] }} />
                            <span style={{ fontSize: 10, color: P.slateD }}>{e.company.name} ({e.alloc}%)</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center", color: P.slateD, fontSize: 13 }}>Use sliders to add companies</div>
                  )}
                </div>
              </div>

              {/* Portfolio Stats + Performance */}
              {portfolioStats && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 14 }}>
                    {[
                      { label: "Wtd Growth", val: `${portfolioStats.wtdGrowth > 0 ? "+" : ""}${portfolioStats.wtdGrowth.toFixed(1)}%`, color: portfolioStats.wtdGrowth > 0 ? P.emerald : P.rose },
                      { label: "Wtd Risk", val: portfolioStats.wtdRisk.toFixed(1), color: portfolioStats.wtdRisk > 50 ? P.rose : P.amber },
                      { label: "Wtd Liquidity", val: portfolioStats.wtdLiquidity.toFixed(0), color: P.sky },
                      { label: "Wtd Valuation", val: `${portfolioStats.wtdValuation.toFixed(1)}x`, color: P.violet },
                      { label: "Holdings", val: portfolioEntries.length, color: P.gold },
                    ].map((k, i) => (
                      <div key={i} className="card scale-in" style={{ padding: "16px 18px", animationDelay: `${i * .06}s` }}>
                        <div className="kl">{k.label}</div>
                        <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 20, fontWeight: 500, color: k.color, marginTop: 6 }}>{k.val}</div>
                      </div>
                    ))}
                  </div>

                  <div className="card fade-in" style={{ padding: "22px" }}>
                    <div className="clabel">Simulated Portfolio Performance — 50 Day</div>
                    <ResponsiveContainer width="100%" height={260}>
                      <AreaChart data={portfolioSeries} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                        <defs>
                          <linearGradient id="portGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={P.gold} stopOpacity={.3} />
                            <stop offset="95%" stopColor={P.gold} stopOpacity={.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                        <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                        <Tooltip content={<TT />} />
                        <Area type="monotone" dataKey="Value" name="Portfolio Value" stroke={P.gold} strokeWidth={2.5} fill="url(#portGrad)" dot={false} style={{ filter: `drop-shadow(0 0 4px ${P.gold}88)` }} />
                        <ReferenceLine y={100} stroke="rgba(255,255,255,.15)" strokeDasharray="4 4" label={{ value: "Baseline", fill: P.slateD, fontSize: 10 }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </>
          )}

          {/* ░░ PEER COMPARISON ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "peers" && (
            <>
              <div className="fade-in" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, color: P.white, fontSize: 14 }}>Compare Entities:</span>
                <div style={{ position: "relative" }}>
                  <input className="inp" value={peerSearch} onChange={e => setPeerSearch(e.target.value)} placeholder="Search companies to compare…" style={{ minWidth: 280 }} />
                  {peerSearchResults.length > 0 && (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#1e293b", border: `1px solid ${P.border}`, borderRadius: 10, marginTop: 4, zIndex: 10, maxHeight: 220, overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.6)" }}>
                      {peerSearchResults.map(c => (
                        <div key={c.id} className="micro-list-item" style={{ padding: "8px 14px", fontSize: 12, color: P.white, cursor: "pointer", transition: "background .15s", borderBottom: `1px solid ${P.border}`, display: "flex", alignItems: "center", gap: 10 }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.06)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                          onClick={() => { setPeerIds(p => [...p, c.id].slice(0, 4)); setPeerSearch(""); }}>
                          <CompanyLogo company={c} size={26} radius={7} />
                          <CountryFlag country={c.country} size={14} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {c.name} <span style={{ color: P.slateD, fontSize: 10 }}>· {c.sector}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {peerCompanies.map((c, i) => (
                  <button key={c.id} type="button" className="peer-btn active peer-btn-rich" style={{ animationDelay: `${i * .05}s`, display: "inline-flex", alignItems: "center", gap: 8 }} onClick={() => setPeerIds(p => p.filter(id => id !== c.id))}>
                    <CompanyLogo company={c} size={20} radius={6} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>{c.name}</span> ✕
                  </button>
                ))}
                {peerIds.length > 0 && (<button className="peer-btn" onClick={() => setPeerIds([])}>Clear All</button>)}
              </div>

              {peerCompanies.length >= 2 ? (
                <>
                  {/* Head-to-Head KPIs */}
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(peerCompanies.length, 4)},1fr)`, gap: 14 }}>
                    {peerCompanies.map((c, i) => (
                      <div key={c.id} className="card scale-in peer-kpi-card" style={{ padding: "18px", animationDelay: `${i * .08}s`, borderTop: `3px solid ${ACCENT[i % ACCENT.length]}` }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                          <CompanyLogo company={c} size={36} radius={10} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: P.white }}>{c.name}</div>
                            <div style={{ fontSize: 10, color: P.slateD, marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                              <CountryFlag country={c.country} size={14} />
                              <span>{c.country}</span>
                              <span>·</span>
                              <span>{c.sector}</span>
                            </div>
                          </div>
                        </div>
                        {[
                          { l: "Capital", v: `$${c.capitalGravity.toFixed(1)}B`, c: P.gold },
                          { l: "Revenue", v: `$${c.revenueFlow.toFixed(1)}B`, c: P.sky },
                          { l: "Growth", v: `${c.growthMomentum > 0 ? "+" : ""}${c.growthMomentum.toFixed(1)}%`, c: c.growthMomentum > 0 ? P.emerald : P.rose },
                          { l: "Risk", v: c.riskCoefficient.toFixed(0), c: c.riskCoefficient > 50 ? P.rose : P.amber },
                          { l: "Liquidity", v: c.liquidityScore.toFixed(0), c: P.sky },
                          { l: "Valuation", v: `${c.valuationIndex.toFixed(1)}x`, c: P.violet },
                        ].map(row => (
                          <div key={row.l} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                            <span style={{ fontSize: 10, color: P.slateD }}>{row.l}</span>
                            <span style={{ fontSize: 12, color: row.c, fontFamily: "DM Mono", fontWeight: 500 }}>{row.v}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>

                  {/* Radar + Bar Comparison */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                    <div className="card slide-in-left" style={{ padding: "22px" }}>
                      <div className="clabel">Metric Radar — Normalized</div>
                      <ResponsiveContainer width="100%" height={300}>
                        <RadarChart data={peerRadarData}>
                          <PolarGrid stroke="rgba(255,255,255,.08)" />
                          <PolarAngleAxis dataKey="metric" tick={{ fill: P.slateD, fontSize: 11 }} />
                          <PolarRadiusAxis tick={false} axisLine={false} />
                          {peerCompanies.map((c, i) => (
                            <Radar key={c.id} name={c.name} dataKey={`c${i}`} stroke={ACCENT[i % ACCENT.length]} fill={ACCENT[i % ACCENT.length]} fillOpacity={.15} strokeWidth={2} />
                          ))}
                          <Legend wrapperStyle={{ fontSize: 11, color: P.slateD }} />
                          <Tooltip content={<TT />} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="card slide-in-right" style={{ padding: "22px" }}>
                      <div className="clabel">Capital & Revenue Comparison</div>
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={peerCompanies.map((c, i) => ({ name: c.name.length > 15 ? c.name.slice(0, 15) + "…" : c.name, Capital: c.capitalGravity, Revenue: c.revenueFlow, color: ACCENT[i % ACCENT.length] }))} margin={{ left: 0, right: 0, bottom: 40 }}>
                          <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                          <XAxis dataKey="name" tick={{ fill: P.slateD, fontSize: 10, fontFamily: "Plus Jakarta Sans" }} tickLine={false} axisLine={false} angle={-20} textAnchor="end" />
                          <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                          <Tooltip content={<TT />} />
                          <Bar dataKey="Capital" name="Capital ($B)" fill={P.gold} fillOpacity={.8} radius={[4, 4, 0, 0]} />
                          <Bar dataKey="Revenue" name="Revenue ($B)" fill={P.sky} fillOpacity={.8} radius={[4, 4, 0, 0]} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Growth Trend Overlay */}
                  <div className="card fade-in" style={{ padding: "22px" }}>
                    <div className="clabel">Share Price Trend — 50 Day Overlay</div>
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                        <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                        <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} allowDuplicatedCategory={false} />
                        <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                        <Tooltip content={<TT />} />
                        {peerCompanies.map((c, i) => {
                          const series = buildCompanySeries(c, 50);
                          return <Line key={c.id} data={series} type="monotone" dataKey="Price" name={c.name} stroke={ACCENT[i % ACCENT.length]} strokeWidth={2.5} dot={false} style={{ filter: `drop-shadow(0 0 3px ${ACCENT[i % ACCENT.length]}66)` }} />;
                        })}
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Risk & Efficiency Bars */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                    <div className="card slide-in-left" style={{ padding: "22px" }}>
                      <div className="clabel">Risk & Liquidity Breakdown</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <BarChart data={peerCompanies.map((c) => ({ name: c.name.length > 12 ? c.name.slice(0, 12) + "…" : c.name, Risk: c.riskCoefficient, Liquidity: c.liquidityScore }))} margin={{ left: 0, right: 0, bottom: 30 }}>
                          <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                          <XAxis dataKey="name" tick={{ fill: P.slateD, fontSize: 11 }} tickLine={false} axisLine={false} angle={-15} textAnchor="end" />
                          <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                          <Tooltip content={<TT />} />
                          <Bar dataKey="Risk" name="Risk Score" fill={P.rose} fillOpacity={.75} radius={[4, 4, 0, 0]} />
                          <Bar dataKey="Liquidity" name="Liquidity" fill={P.sky} fillOpacity={.75} radius={[4, 4, 0, 0]} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="card slide-in-right" style={{ padding: "22px" }}>
                      <div className="clabel">Efficiency & Valuation</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <BarChart data={peerCompanies.map((c) => ({ name: c.name.length > 12 ? c.name.slice(0, 12) + "…" : c.name, Efficiency: (c.efficiencyRatio * 100), Valuation: c.valuationIndex }))} margin={{ left: 0, right: 0, bottom: 30 }}>
                          <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                          <XAxis dataKey="name" tick={{ fill: P.slateD, fontSize: 11 }} tickLine={false} axisLine={false} angle={-15} textAnchor="end" />
                          <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                          <Tooltip content={<TT />} />
                          <Bar dataKey="Efficiency" name="Efficiency %" fill={P.emerald} fillOpacity={.75} radius={[4, 4, 0, 0]} />
                          <Bar dataKey="Valuation" name="Valuation (x)" fill={P.violet} fillOpacity={.75} radius={[4, 4, 0, 0]} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </>
              ) : (
                <div className="card fade-in" style={{ padding: "60px 22px", textAlign: "center" }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>⚖️</div>
                  <div style={{ color: P.white, fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Select at least 2 companies to compare</div>
                  <div style={{ color: P.slateD, fontSize: 12 }}>Search above and click to add companies. You can compare up to 4 entities side-by-side.</div>
                </div>
              )}
            </>
          )}

          {/* ░░ RISK & CORRELATION ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "risk" && (
            <>
              {/* Risk KPIs */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(175px,1fr))", gap: 14 }}>
                {[
                  { label: "Avg Risk Score", val: (filtered.reduce((a, c) => a + c.riskCoefficient, 0) / (filtered.length || 1)).toFixed(1), color: P.amber },
                  { label: "High Risk Entities", val: filtered.filter(c => c.riskCoefficient > 70).length, color: P.rose },
                  { label: "Low Risk Entities", val: filtered.filter(c => c.riskCoefficient < 30).length, color: P.emerald },
                  { label: "Avg Efficiency", val: `${(filtered.reduce((a, c) => a + c.efficiencyRatio, 0) / (filtered.length || 1) * 100).toFixed(1)}%`, color: P.sky },
                  { label: "Avg Liquidity", val: (filtered.reduce((a, c) => a + c.liquidityScore, 0) / (filtered.length || 1)).toFixed(0), color: P.violet },
                ].map((k, i) => (
                  <div key={i} className="card fu" style={{ padding: "16px 18px", animationDelay: `${i * .05}s` }}>
                    <div className="kl">{k.label}</div>
                    <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 20, fontWeight: 500, color: k.color, marginTop: 6 }}>{k.val}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                {/* Risk Distribution */}
                <div className="card slide-in-left" style={{ padding: "22px" }}>
                  <div className="clabel">Risk Distribution — Histogram</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={riskBuckets} margin={{ left: 0, right: 0, top: 10, bottom: 0 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="range" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<TT />} />
                      <Bar dataKey="count" name="Entities" radius={[4, 4, 0, 0]}>
                        {riskBuckets.map((b, i) => (<Cell key={i} fill={b.color} fillOpacity={.8} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Sector Risk Ranking */}
                <div className="card slide-in-right" style={{ padding: "22px" }}>
                  <div className="clabel">Sector Risk Ranking</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={sectorRisk} layout="vertical" margin={{ left: 120, right: 12 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="sector" tick={{ fill: P.slate, fontSize: 13, fontFamily: "Plus Jakarta Sans", fontWeight: 500 }} tickLine={false} width={120} />
                      <Tooltip content={<TT />} />
                      <Bar dataKey="avgRisk" name="Avg Risk" radius={[0, 5, 5, 0]}>
                        {sectorRisk.map((s, i) => (<Cell key={i} fill={s.avgRisk > 50 ? P.rose : s.avgRisk > 30 ? P.amber : P.emerald} fillOpacity={.8} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Risk vs Growth Scatter */}
              <div className="card fade-in" style={{ padding: "22px" }}>
                <div className="clabel">Risk × Growth Momentum — Entity Scatter</div>
                <ResponsiveContainer width="100%" height={320}>
                  <ScatterChart margin={{ left: 10, right: 10, top: 10, bottom: 10 }}>
                    <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                    <XAxis dataKey="riskCoefficient" name="Risk" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "Risk Coefficient →", position: "insideBottom", offset: -5, fill: P.slateD, fontSize: 10 }} />
                    <YAxis dataKey="growthMomentum" name="Growth" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "Growth % →", angle: -90, position: "insideLeft", offset: 5, fill: P.slateD, fontSize: 10 }} />
                    <ZAxis dataKey="capitalGravity" range={[30, 250]} />
                    <Tooltip content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0]?.payload;
                      return <div style={{ background: "#111827", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "10px 14px", fontSize: 12 }}>
                        <div style={{ color: P.gold, fontWeight: 700 }}>{d?.name}</div>
                        <div style={{ color: P.slateD, marginTop: 4 }}>Risk: <span style={{ color: P.rose, fontFamily: "DM Mono" }}>{d?.riskCoefficient?.toFixed(1)}</span></div>
                        <div style={{ color: P.slateD }}>Growth: <span style={{ color: P.emerald, fontFamily: "DM Mono" }}>{d?.growthMomentum?.toFixed(1)}%</span></div>
                      </div>;
                    }} />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,.1)" strokeDasharray="3 3" />
                    <ReferenceLine x={50} stroke="rgba(255,255,255,.1)" strokeDasharray="3 3" />
                    <Scatter data={filtered.slice(0, 100)}>
                      {filtered.slice(0, 100).map((c, i) => (<Cell key={i} fill={SECTOR_COLORS[c.sector] || P.gold} fillOpacity={.75} />))}
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>

              {/* Liquidity vs Efficiency + Sector Radar */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                <div className="card slide-in-left" style={{ padding: "22px" }}>
                  <div className="clabel">Liquidity × Efficiency — Entity Map</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <ScatterChart margin={{ left: 10, right: 10, top: 10, bottom: 10 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="liquidityScore" name="Liquidity" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "Liquidity →", position: "insideBottom", offset: -5, fill: P.slateD, fontSize: 10 }} />
                      <YAxis dataKey="efficiencyRatio" name="Efficiency" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "Efficiency →", angle: -90, position: "insideLeft", offset: 5, fill: P.slateD, fontSize: 10 }} />
                      <ZAxis dataKey="capitalGravity" range={[30, 200]} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload;
                        return <div style={{ background: "#111827", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "10px 14px", fontSize: 13 }}>
                          <div style={{ color: P.gold, fontWeight: 700 }}>{d?.name}</div>
                          <div style={{ color: P.slateD, marginTop: 4 }}>Liquidity: <span style={{ color: P.sky, fontFamily: "DM Mono" }}>{d?.liquidityScore?.toFixed(0)}</span></div>
                          <div style={{ color: P.slateD }}>Efficiency: <span style={{ color: P.emerald, fontFamily: "DM Mono" }}>{(d?.efficiencyRatio * 100)?.toFixed(1)}%</span></div>
                        </div>;
                      }} />
                      <Scatter data={filtered.slice(0, 80)}>
                        {filtered.slice(0, 80).map((c, i) => (<Cell key={i} fill={SECTOR_COLORS[c.sector] || P.gold} fillOpacity={.7} />))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <div className="card slide-in-right" style={{ padding: "22px" }}>
                  <div className="clabel">Sector Profile Radar</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <RadarChart data={sectorRisk.slice(0, 6).map(s => ({ sector: s.sector.length > 14 ? s.sector.slice(0, 14) + "…" : s.sector, Growth: Math.max(0, s.avgGrowth), Liquidity: s.avgLiquidity, Risk: s.avgRisk, Valuation: Math.min(s.avgValuation, 50) }))}>
                      <PolarGrid stroke="rgba(255,255,255,.08)" />
                      <PolarAngleAxis dataKey="sector" tick={{ fill: P.slateD, fontSize: 11 }} />
                      <PolarRadiusAxis tick={false} axisLine={false} />
                      <Radar name="Growth" dataKey="Growth" stroke={P.emerald} fill={P.emerald} fillOpacity={.12} strokeWidth={2} />
                      <Radar name="Liquidity" dataKey="Liquidity" stroke={P.sky} fill={P.sky} fillOpacity={.12} strokeWidth={2} />
                      <Radar name="Risk" dataKey="Risk" stroke={P.rose} fill={P.rose} fillOpacity={.12} strokeWidth={2} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Tooltip content={<TT />} />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Correlation Matrix */}
              <div className="card fade-in" style={{ padding: "22px" }}>
                <div className="clabel">Metric Correlation Matrix</div>
                <CorrMatrix />
              </div>
            </>
          )}

          {/* ░░ HISTORICAL TRENDS ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "history" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(185px,1fr))", gap: 14 }}>
                {[
                  { label: "6M Index High", value: Math.max(...historicalSeries.map(d => d.Index)).toFixed(0), color: P.emerald },
                  { label: "6M Index Low", value: Math.min(...historicalSeries.map(d => d.Index)).toFixed(0), color: P.rose },
                  { label: "Current Index", value: historicalSeries[historicalSeries.length - 1]?.Index.toFixed(0), color: P.gold },
                  { label: "Trend Direction", value: historicalSeries[historicalSeries.length - 1]?.Index > historicalSeries[0]?.Index ? "Bullish ▲" : "Bearish ▼", color: historicalSeries[historicalSeries.length - 1]?.Index > historicalSeries[0]?.Index ? P.emerald : P.rose },
                  { label: "Avg Daily Change", value: ((historicalSeries[historicalSeries.length - 1]?.Index - historicalSeries[0]?.Index) / 180).toFixed(2), color: P.sky },
                ].map((k, i) => (
                  <div key={i} className="card fu" style={{ padding: "18px 20px", animationDelay: `${i * .05}s` }}>
                    <div className="kl">{k.label}</div>
                    <div className="kv" style={{ color: k.color, fontSize: 24 }}>{k.value}</div>
                  </div>
                ))}
              </div>

              {/* Main Index Chart with Moving Averages */}
              <div className="card fade-in" style={{ padding: "22px" }}>
                <div className="clabel">Global Index Trend — 6 Month (with MA20 / MA50)</div>
                <ResponsiveContainer width="100%" height={360}>
                  <AreaChart data={historicalSeries} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="histGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={P.gold} stopOpacity={.3} />
                        <stop offset="95%" stopColor={P.gold} stopOpacity={.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                    <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 11 }} tickLine={false} axisLine={false} interval={14} />
                    <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<TT />} />
                    <Area type="monotone" dataKey="Index" name="Index" stroke={P.gold} strokeWidth={2} fill="url(#histGrad)" dot={false} />
                    <Line type="monotone" dataKey="MA20" name="MA 20" stroke={P.emerald} strokeWidth={1.5} dot={false} strokeDasharray="4 3" connectNulls={false} />
                    <Line type="monotone" dataKey="MA50" name="MA 50" stroke={P.sky} strokeWidth={1.5} dot={false} strokeDasharray="6 3" connectNulls={false} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Brush dataKey="label" height={28} stroke={P.gold} travellerWidth={10} fill="rgba(255,255,255,.03)" startIndex={90} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Sector Performance Over Time (stacked area) */}
              <div className="card slide-in-left" style={{ padding: "22px" }}>
                <div className="clabel">Sector Capital Volume — Monthly Momentum</div>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={Array.from({ length: 12 }, (_, m) => ({ month: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m], ...Object.fromEntries(sectorData.slice(0, 5).map(s => [s.sector, s.capitalGravity * (0.8 + Math.sin((m + 1) / 3) * 0.3 + rnd(-0.05, 0.05))])) }))} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                    <XAxis dataKey="month" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<TT />} />
                    {sectorData.slice(0, 5).map((s) => (
                      <Area key={s.sector} type="monotone" dataKey={s.sector} name={s.sector} stackId="1" stroke={s.color} fill={s.color} fillOpacity={.25} strokeWidth={1.5} />
                    ))}
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          {/* ░░ DIVIDEND & YIELD ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "dividend" && (
            <>
              <div className="premium-hero card premium-card" style={{ padding: "22px 26px", marginBottom: 4 }}>
                <div className="premium-title" style={{ fontSize: "clamp(1.15rem, 2.8vw, 1.65rem)" }}>Income &amp; shareholder yield</div>
                <p className="premium-sub" style={{ maxWidth: 720, marginTop: 8 }}>
                  Figures refresh with the batch quote feed (Yahoo Finance). Averages skip missing fields so NaNs never break the view. Compare trailing yield, payout pressure, and five-year history before you size a dividend sleeve.
                </p>
                <div className="premium-kpi-row" style={{ marginTop: 18 }}>
                  <div>
                    <div className="premium-metric-label">Universe</div>
                    <div className="premium-metric-val">{filtered.length}</div>
                  </div>
                  <div>
                    <div className="premium-metric-label">With TTM yield</div>
                    <div className="premium-metric-val" style={{ color: P.emerald }}>{dividendScreen.withYieldCount}</div>
                  </div>
                  <div>
                    <div className="premium-metric-label">No / zero yield</div>
                    <div className="premium-metric-val" style={{ color: P.slate }}>{dividendScreen.nonPayers}</div>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 14 }}>
                {[
                  { label: "Avg TTM yield (payers)", value: fmtNum(dividendScreen.avgDivYield, 2, "%", ""), color: P.gold },
                  { label: "Avg P / E", value: fmtNum(dividendScreen.avgPE, 1, "x", ""), color: P.amber },
                  { label: "Avg P / B", value: fmtNum(dividendScreen.avgPB, 2, "x", ""), color: P.sky },
                  { label: "Avg ROE", value: fmtNum(dividendScreen.avgROE, 1, "%", ""), color: P.emerald },
                  { label: "Avg Sharpe", value: fmtNum(dividendScreen.avgSharpe, 2, "", ""), color: P.violet },
                  { label: "Avg EBITDA margin", value: fmtNum(dividendScreen.avgEbitda, 1, "%", ""), color: P.rose },
                  { label: "Avg payout on earnings", value: fmtNum(dividendScreen.avgPayout, 1, "%", ""), color: P.amber },
                  { label: "Avg 5Y yield (where known)", value: fmtNum(dividendScreen.avgDiv5Y, 2, "%", ""), color: P.emerald },
                ].map((k, i) => (
                  <div key={i} className="card fu premium-card" style={{ padding: "18px 20px", animationDelay: `${i * .05}s` }}>
                    <div className="kl">{k.label}</div>
                    <div className="kv" style={{ color: k.color, fontSize: 22 }}>{k.value}</div>
                  </div>
                ))}
              </div>

              <div className="chart-split" style={{ marginTop: 6 }}>
                <div className="card slide-in-left premium-card" style={{ padding: "22px" }}>
                  <div className="clabel">Dividend yield by sector (mean of payers)</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart
                      data={sectorData.map((s) => {
                        const comps = filtered.filter((c) => c.sector === s.sector);
                        const divVals = comps.map((c) => c.dividendYield).filter((v) => v != null && typeof v === "number" && !Number.isNaN(v));
                        const avg = finiteMean(divVals) ?? 0;
                        return {
                          sector: s.sector.length > 14 ? s.sector.slice(0, 14) + "…" : s.sector,
                          Yield: avg,
                          color: s.color,
                        };
                      })}
                      layout="vertical"
                      margin={{ left: 120, right: 12 }}
                    >
                      <CartesianGrid stroke="rgba(255,255,255,.05)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="sector" tick={{ fill: P.slate, fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontWeight: 500 }} tickLine={false} width={120} />
                      <Tooltip content={<TT />} />
                      <Bar dataKey="Yield" name="Avg yield %" radius={[0, 5, 5, 0]}>
                        {sectorData.map((s, i) => (<Cell key={i} fill={s.color} fillOpacity={.78} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="card slide-in-right premium-card" style={{ padding: "22px" }}>
                  <div className="clabel">Valuation vs income — P / E × trailing yield</div>
                  <ResponsiveContainer width="100%" height={280}>
                    <ScatterChart margin={{ left: 10, right: 10, top: 10, bottom: 10 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="peRatio" name="P/E" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "P/E ratio →", position: "insideBottom", offset: -5, fill: P.slateD, fontSize: 10 }} />
                      <YAxis dataKey="dividendYield" name="Div yield" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "Yield % →", angle: -90, position: "insideLeft", offset: 5, fill: P.slateD, fontSize: 10 }} />
                      <ZAxis dataKey="capitalGravity" range={[30, 200]} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload;
                        return (
                          <div style={{ background: "#111827", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "10px 14px", fontSize: 13 }}>
                            <div style={{ color: P.gold, fontWeight: 700 }}>{d?.name}</div>
                            <div style={{ color: P.slateD, marginTop: 4 }}>P/E: <span style={{ color: P.amber, fontFamily: "DM Mono, monospace" }}>{fmtNum(d?.peRatio, 1, "x", "")}</span></div>
                            <div style={{ color: P.slateD }}>Yield: <span style={{ color: P.emerald, fontFamily: "DM Mono, monospace" }}>{fmtNum(d?.dividendYield, 2, "%", "")}</span></div>
                            <div style={{ color: P.slateD, marginTop: 4 }}>Payout: <span style={{ fontFamily: "DM Mono, monospace" }}>{fmtNum(d?.payoutRatioPct, 1, "%", "")}</span></div>
                          </div>
                        );
                      }} />
                      <Scatter data={dividendScreen.scatterYield}>
                        {dividendScreen.scatterYield.map((c, i) => (<Cell key={i} fill={SECTOR_COLORS[c.sector] || P.gold} fillOpacity={.7} />))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="card fade-in premium-card" style={{ padding: "22px" }}>
                <div className="clabel">Dividend quality — top 15 by market cap in view</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${P.border}` }}>
                        {["Issuer", "P/E", "P/B", "D/E", "ROE", "ROA", "β", "Sharpe", "EBITDA %", "Div TTM", "FCF yield", "Payout", "5Y avg", "Ex-div", "$ / sh"].map((h) => (
                          <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, color: P.slateD, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...filtered].sort((a, b) => b.capitalGravity - a.capitalGravity).slice(0, 15).map((c) => (
                        <tr key={c.id} className="trow">
                          <td style={{ padding: "8px 10px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <CompanyLogo company={c} size={32} radius={8} />
                              <CountryFlag country={c.country} size={16} />
                              <div>
                                <div style={{ color: P.white, fontWeight: 600, fontSize: 13 }}>{c.name}</div>
                                <div style={{ fontSize: 11, color: P.slateD, fontFamily: "DM Mono, monospace" }}>{c.symbol}</div>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.peRatio != null && c.peRatio > 40 ? P.rose : P.amber, fontSize: 13 }}>{fmtNum(c.peRatio, 1, "", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: P.sky, fontSize: 13 }}>{fmtNum(c.pbRatio, 2, "", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.debtEquity != null && c.debtEquity > 2 ? P.rose : P.slate, fontSize: 13 }}>{fmtNum(c.debtEquity, 2, "", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.roe != null && c.roe > 15 ? P.emerald : c.roe != null && c.roe < 0 ? P.rose : P.slate, fontSize: 13 }}>{fmtNum(c.roe, 1, "%", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.roa != null && c.roa > 10 ? P.emerald : c.roa != null && c.roa < 0 ? P.rose : P.slate, fontSize: 13 }}>{fmtNum(c.roa, 1, "%", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.beta != null && c.beta > 1.5 ? P.rose : c.beta != null && c.beta < 0.8 ? P.emerald : P.slate, fontSize: 13 }}>{fmtNum(c.beta, 2, "", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.sharpeRatio != null && c.sharpeRatio > 1.5 ? P.emerald : c.sharpeRatio != null && c.sharpeRatio < 0 ? P.rose : P.amber, fontSize: 13 }}>{fmtNum(c.sharpeRatio, 2, "", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.ebitdaMargin != null && c.ebitdaMargin > 30 ? P.emerald : P.slate, fontSize: 13 }}>{fmtNum(c.ebitdaMargin, 1, "%", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: P.gold, fontSize: 13 }}>{fmtNum(c.dividendYield, 2, "%", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", color: c.fcfYield != null && c.fcfYield > 5 ? P.emerald : c.fcfYield != null && c.fcfYield < 0 ? P.rose : P.slate, fontSize: 13 }}>{fmtNum(c.fcfYield, 2, "%", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", fontSize: 13 }}>{fmtNum(c.payoutRatioPct, 1, "%", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", fontSize: 13 }}>{fmtNum(c.divYield5YAvg, 2, "%", "")}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", fontSize: 12, color: P.slate }}>{c.exDividendDate || "—"}</td>
                          <td style={{ padding: "8px 10px", fontFamily: "DM Mono, monospace", fontSize: 13 }}>{fmtNum(c.dividendAnnual, 2, "", "$")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="chart-split">
                <div className="card slide-in-left premium-card" style={{ padding: "22px" }}>
                  <div className="clabel">Sharpe ratio — top 10 in view</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={dividendSharpeLeaders.map((c) => ({ name: c.name.length > 12 ? c.name.slice(0, 12) + "…" : c.name, Sharpe: c.sharpeRatio }))} margin={{ left: 0, right: 0, bottom: 30 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="name" tick={{ fill: P.slateD, fontSize: 11 }} tickLine={false} axisLine={false} angle={-15} textAnchor="end" />
                      <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<TT />} />
                      <Bar dataKey="Sharpe" name="Sharpe" radius={[4, 4, 0, 0]}>
                        {dividendSharpeLeaders.map((c, i) => (<Cell key={i} fill={c.sharpeRatio > 1.5 ? P.emerald : c.sharpeRatio > 0 ? P.amber : P.rose} fillOpacity={.8} />))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="card slide-in-right premium-card" style={{ padding: "22px" }}>
                  <div className="clabel">ROE × debt / equity</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <ScatterChart margin={{ left: 10, right: 10, top: 10, bottom: 10 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="debtEquity" name="D/E" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "D/E →", position: "insideBottom", offset: -5, fill: P.slateD, fontSize: 10 }} />
                      <YAxis dataKey="roe" name="ROE" tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "ROE % →", angle: -90, position: "insideLeft", offset: 5, fill: P.slateD, fontSize: 10 }} />
                      <ZAxis dataKey="capitalGravity" range={[30, 200]} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload;
                        return (
                          <div style={{ background: "#111827", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "10px 14px", fontSize: 13 }}>
                            <div style={{ color: P.gold, fontWeight: 700 }}>{d?.name}</div>
                            <div style={{ color: P.slateD, marginTop: 4 }}>D/E: <span style={{ color: P.amber, fontFamily: "DM Mono, monospace" }}>{fmtNum(d?.debtEquity, 2, "", "")}</span></div>
                            <div style={{ color: P.slateD }}>ROE: <span style={{ color: P.emerald, fontFamily: "DM Mono, monospace" }}>{fmtNum(d?.roe, 1, "%", "")}</span></div>
                          </div>
                        );
                      }} />
                      <Scatter data={roeDeScatter.slice(0, 80)}>
                        {roeDeScatter.slice(0, 80).map((c, i) => (<Cell key={i} fill={SECTOR_COLORS[c.sector] || P.gold} fillOpacity={.7} />))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}

          {/* ░░ STOCK ANALYSIS (lightweight-charts) ░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "stocklab" && (
            <div className="card premium-card slide-in-left" style={{ padding: "24px 26px", overflow: "hidden" }}>
              <div className="premium-title" style={{ fontSize: "clamp(1.2rem, 2.8vw, 1.7rem)", marginBottom: 6 }}>Pro chart desk</div>
              <p className="premium-sub" style={{ marginBottom: 18, maxWidth: 800 }}>
                Same live pipeline as the rest of Meridian: OHLCV from your API, EMA overlays, histogram volume, and RSI for timing around income and quality work on the Dividend tab.
              </p>
              <StockLab companies={sortedFiltered} palette={P} chartHeight={400} />
            </div>
          )}

          {/* ░░ MONTE CARLO SIMULATION ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "montecarlo" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(185px,1fr))", gap: 14 }}>
                {[
                  { label: "VaR (5%)", value: `${monteCarlo.var5.toFixed(1)}%`, color: P.rose },
                  { label: "Median Return", value: `${monteCarlo.median.toFixed(1)}%`, color: P.gold },
                  { label: "Mean Return", value: `${monteCarlo.mean.toFixed(1)}%`, color: P.emerald },
                  { label: "Simulations", value: "200", color: P.sky },
                  { label: "Time Horizon", value: "60 Days", color: P.violet },
                ].map((k, i) => (
                  <div key={i} className="card fu counter-anim" style={{ padding: "18px 20px", animationDelay: `${i * .06}s` }}>
                    <div className="kl">{k.label}</div>
                    <div className="kv" style={{ color: k.color, fontSize: 24 }}>{k.value}</div>
                  </div>
                ))}
              </div>

              {/* Sample Paths */}
              <div className="card fade-in" style={{ padding: "22px" }}>
                <div className="clabel">Monte Carlo — 15 Sample Paths (60 Day)</div>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                    <XAxis dataKey="day" tick={{ fill: P.slateD, fontSize: 11 }} tickLine={false} axisLine={false} allowDuplicatedCategory={false} type="number" domain={[0, 60]} />
                    <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<TT />} />
                    {monteCarlo.samplePaths.map((path, i) => (
                      <Line key={i} data={path} type="monotone" dataKey="val" name={`Run ${i + 1}`} stroke={ACCENT[i % ACCENT.length]} strokeWidth={1.2} dot={false} strokeOpacity={.6} />
                    ))}
                    <ReferenceLine y={100} stroke="rgba(255,255,255,.2)" strokeDasharray="4 4" label={{ value: "Baseline", fill: P.slateD, fontSize: 10 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Distribution Histogram */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                <div className="card slide-in-left" style={{ padding: "22px" }}>
                  <div className="clabel">Return Distribution — Histogram</div>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={monteCarlo.buckets} margin={{ left: 0, right: 0, bottom: 5 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="range" tick={{ fill: P.slateD, fontSize: 10 }} tickLine={false} axisLine={false} angle={-30} textAnchor="end" />
                      <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<TT />} />
                      <Bar dataKey="count" name="Frequency" radius={[4, 4, 0, 0]}>
                        {monteCarlo.buckets.map((b, i) => (<Cell key={i} fill={b.lo < 80 ? P.rose : b.lo < 100 ? P.amber : P.emerald} fillOpacity={.75} />))}
                      </Bar>
                      <ReferenceLine x={`${Math.floor(monteCarlo.var5 / 4) * 4}-${Math.floor(monteCarlo.var5 / 4) * 4 + 4}`} stroke={P.rose} strokeDasharray="3 3" label={{ value: "VaR 5%", fill: P.rose, fontSize: 10 }} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Sector Rotation */}
                <div className="card slide-in-right" style={{ padding: "22px" }}>
                  <div className="clabel">Sector Rotation — Lifecycle Phases</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginTop: 8 }}>
                    {sectorRotation.map((s, i) => {
                      const phaseColors = [P.emerald, P.gold, P.amber, P.rose];
                      return (
                        <div key={i} className="card-flat fu" style={{ padding: "12px", textAlign: "center", animationDelay: `${i * .05}s`, borderTop: `3px solid ${phaseColors[s.phase]}` }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: P.white, marginBottom: 4 }}>{s.sector.length > 16 ? s.sector.slice(0, 16) + "…" : s.sector}</div>
                          <div style={{ fontSize: 10, color: phaseColors[s.phase], fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 4 }}>{s.phaseName}</div>
                          <div style={{ fontFamily: "DM Mono", fontSize: 13, color: s.avgGrowth > 0 ? P.emerald : P.rose }}>{s.avgGrowth > 0 ? "+" : ""}{s.avgGrowth.toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Sector ETF Performance */}
              <div className="card fade-in" style={{ padding: "22px" }}>
                <div className="clabel">Sector ETF Simulation — 90 Day Performance</div>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                    <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 11 }} tickLine={false} axisLine={false} allowDuplicatedCategory={false} />
                    <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<TT />} />
                    {sectorETFs.map(etf => (
                      <Line key={etf.sector} data={etf.series} type="monotone" dataKey="value" name={`${etf.sector} (${etf.expense}%)`} stroke={etf.color} strokeWidth={2} dot={false} />
                    ))}
                    <ReferenceLine y={100} stroke="rgba(255,255,255,.15)" strokeDasharray="4 4" />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Brush dataKey="label" height={24} stroke={P.gold} fill="rgba(255,255,255,.03)" startIndex={30} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Achievements */}
              <div className="card scale-in" style={{ padding: "22px" }}>
                <div className="clabel">Achievements — {achievements.filter(a => a.unlocked).length}/{achievements.length} Unlocked</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
                  {achievements.map(a => (
                    <div key={a.id} className={`achievement ${a.unlocked ? '' : 'locked'}`}>
                      <div className="ach-icon">{a.icon}</div>
                      <div className="ach-info">
                        <div className="ach-title">{a.title}</div>
                        <div className="ach-desc">{a.desc}</div>
                      </div>
                      {a.unlocked && <span style={{ marginLeft: "auto", color: P.emerald, fontSize: 16 }}>✓</span>}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ░░ TECHNICAL INDICATORS ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ */}
          {tab === "technical" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(185px,1fr))", gap: 14 }}>
                {[
                  { label: "Current RSI", value: techData[techData.length - 1]?.RSI.toFixed(1), color: techData[techData.length - 1]?.RSI > 70 ? P.rose : techData[techData.length - 1]?.RSI < 30 ? P.emerald : P.amber },
                  { label: "MACD Signal", value: techData[techData.length - 1]?.MACD.toFixed(1), color: techData[techData.length - 1]?.MACD > 0 ? P.emerald : P.rose },
                  { label: "Bollinger Width", value: ((techData[techData.length - 1]?.BB_Upper - techData[techData.length - 1]?.BB_Lower) / techData[techData.length - 1]?.SMA20 * 100).toFixed(1) + "%", color: P.sky },
                  { label: "SMA20", value: techData[techData.length - 1]?.SMA20.toFixed(0), color: P.emerald },
                  { label: "Signal", value: techData[techData.length - 1]?.MACD > techData[techData.length - 1]?.Signal ? "Bullish ▲" : "Bearish ▼", color: techData[techData.length - 1]?.MACD > techData[techData.length - 1]?.Signal ? P.emerald : P.rose },
                ].map((k, i) => (
                  <div key={i} className="card fu counter-anim" style={{ padding: "18px 20px", animationDelay: `${i * .06}s` }}>
                    <div className="kl">{k.label}</div>
                    <div className="kv" style={{ color: k.color, fontSize: 24 }}>{k.value}</div>
                  </div>
                ))}
              </div>

              {/* Bollinger Bands */}
              <div className="card fade-in" style={{ padding: "22px" }}>
                <div className="clabel">Bollinger Bands (20,2) + SMA20</div>
                <ResponsiveContainer width="100%" height={340}>
                  <AreaChart data={techData} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="bbGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={P.sky} stopOpacity={.12} />
                        <stop offset="95%" stopColor={P.sky} stopOpacity={.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                    <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 11 }} tickLine={false} axisLine={false} interval={14} />
                    <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                    <Tooltip content={<TT />} />
                    <Area type="monotone" dataKey="BB_Upper" name="Upper Band" stroke={P.sky} strokeWidth={1} fill="url(#bbGrad)" strokeDasharray="3 3" dot={false} />
                    <Area type="monotone" dataKey="BB_Lower" name="Lower Band" stroke={P.sky} strokeWidth={1} fill="transparent" strokeDasharray="3 3" dot={false} />
                    <Line type="monotone" dataKey="Index" name="Price" stroke={P.gold} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="SMA20" name="SMA 20" stroke={P.emerald} strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Brush dataKey="label" height={24} stroke={P.gold} fill="rgba(255,255,255,.03)" startIndex={100} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* RSI + MACD */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                <div className="card slide-in-left" style={{ padding: "22px" }}>
                  <div className="clabel">RSI (14) — Relative Strength Index</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={techData} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 10 }} tickLine={false} axisLine={false} interval={20} />
                      <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} domain={[0, 100]} />
                      <Tooltip content={<TT />} />
                      <ReferenceLine y={70} stroke={P.rose} strokeDasharray="3 3" label={{ value: "Overbought", fill: P.rose, fontSize: 9 }} />
                      <ReferenceLine y={30} stroke={P.emerald} strokeDasharray="3 3" label={{ value: "Oversold", fill: P.emerald, fontSize: 9 }} />
                      <Line type="monotone" dataKey="RSI" name="RSI" stroke={P.violet} strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="card slide-in-right" style={{ padding: "22px" }}>
                  <div className="clabel">MACD (12,26,9) — Convergence/Divergence</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={techData} margin={{ left: 0, right: 10, top: 10, bottom: 0 }}>
                      <CartesianGrid stroke="rgba(255,255,255,.05)" strokeDasharray="4 4" />
                      <XAxis dataKey="label" tick={{ fill: P.slateD, fontSize: 10 }} tickLine={false} axisLine={false} interval={20} />
                      <YAxis tick={{ fill: P.slateD, fontSize: 12 }} tickLine={false} axisLine={false} />
                      <Tooltip content={<TT />} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,.1)" />
                      <Bar dataKey="Histogram" name="Histogram" radius={[2, 2, 0, 0]}>
                        {techData.map((d, i) => (<Cell key={i} fill={d.Histogram > 0 ? P.emerald : P.rose} fillOpacity={.5} />))}
                      </Bar>
                      <Line type="monotone" dataKey="MACD" name="MACD" stroke={P.sky} strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Signal" name="Signal" stroke={P.amber} strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}

        </div>

        {/* ═══ FOOTER ════════════════════════════════════════════════════════ */}
        <div style={{ padding: "12px 28px", borderTop: `1px solid ${P.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontSize: 10, color: P.slateD, fontWeight: 500, letterSpacing: ".1em" }}>
            MIT-WPU DEDV LAB © 2026 — {filtered.length} entities · {COUNTRIES.length} economies · {SECTORS.length} sectors
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div className="dot" />
            <span style={{ fontSize: 10, color: P.slateD }}>Live feed · 2.5s refresh</span>
          </div>
        </div>
      </div>
    </>
  );
}