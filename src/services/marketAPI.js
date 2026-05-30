const BASE = (import.meta.env.VITE_API_BASE ?? 'http://localhost:5000').trim();

/**
 * Fetch full company metrics + chart data for one ticker.
 * Returns { metrics, chart }.
 */
export async function getStockData(ticker, period = '3mo') {
  const res = await fetch(`${BASE}/api/stock/${encodeURIComponent(ticker)}?period=${period}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Failed to fetch ${ticker}`);
  }
  return res.json();
}

/**
 * Fetch the global ticker map grouped by country.
 */
export async function getGlobalTickers() {
  const res = await fetch(`${BASE}/api/search`);
  if (!res.ok) throw new Error('Failed to fetch ticker list');
  return res.json();
}

/**
 * Fetch metrics for multiple tickers (batch). Max 20 symbols per request.
 */
export async function getBatchQuotes(tickers = []) {
  const joined = tickers.join(',');
  const res = await fetch(`${BASE}/api/batch?tickers=${encodeURIComponent(joined)}`);
  if (!res.ok) throw new Error('Batch fetch failed');
  return res.json();
}

/**
 * Normalize backend chart rows for Recharts (preserves existing dataKeys).
 */
export function normalizeChart(chartArray = []) {
  return chartArray.map((d, idx) => ({
    name: d.Date,
    date: d.Date,
    label: typeof d.Date === 'string' ? d.Date.slice(0, 10) : `D${idx + 1}`,
    open: d.Open,
    high: d.High,
    low: d.Low,
    close: d.Close,
    value: d.Close,
    price: d.Close,
    Price: d.Close,
    volume: d.Volume,
  }));
}

/**
 * Build stub rows from /api/search map (before batch enrichment).
 */
export function stubsFromGlobalMap(globalMap) {
  let id = 0;
  const rows = [];
  for (const [cn, tickers] of Object.entries(globalMap || {})) {
    for (const t of tickers || []) {
      rows.push(createStubRow(id++, t, cn));
    }
  }
  return rows;
}

function createStubRow(id, symbol, country) {
  return {
    id,
    symbol,
    name: symbol,
    sector: 'Unknown',
    country,
    // Currency: defaults to USD until the API enriches the row.
    // currency = ISO 4217 code for the share price (e.g. 'INR', 'JPY', 'EUR').
    // capitalGravity / revenueFlow / netYield are always stored in USD billions.
    currency: 'USD',
    financialCurrency: 'USD',
    website: null,
    logoUrl: null,
    finnhubLogo: null,
    capitalGravity: 0,
    revenueFlow: 0,
    netYield: 0,
    valuationIndex: 0,
    sharePrice: 0,
    dividendRate: null,
    dividendAnnual: null,
    payoutRatioPct: null,
    divYield5YAvg: null,
    exDividendDate: null,
    liquidityScore: 0,
    growthMomentum: 0,
    riskCoefficient: 0,
    efficiencyRatio: 0,
    peRatio: null,
    pbRatio: null,
    debtEquity: null,
    roe: null,
    roa: null,
    beta: null,
    sharpeRatio: null,
    dividendYield: null,
    ebitdaMargin: null,
    fcfYield: null,
    esgEnv: 55,
    esgSoc: 55,
    esgGov: 55,
    esgTotal: 55,
    priceHistory: null,
  };
}

/**
 * Merge Flask compute_metrics output into the company row shape App.jsx expects.
 */
export function mergeApiMetricsToCompany(row, metrics) {
  if (!metrics || metrics.error) {
    return { ...row, loadError: metrics?.error || null };
  }
  const r = metrics.raw || {};
  // All raw monetary values from backend are already converted to USD.
  const mcap = r.marketCap;       // USD
  const rev  = r.totalRevenue;    // USD
  let netB = null;
  if (r.netIncome != null && r.netIncome > 0) netB = r.netIncome / 1e9;
  else if (r.eps != null && r.sharesOut != null) {
    // EPS is in local currency; we skip this fallback to avoid mixing currencies.
    netB = null;
  }
  const capB = mcap != null ? mcap / 1e9 : 0;   // USD billions
  const revB = rev  != null ? rev  / 1e9 : 0;   // USD billions
  const valIx = rev && mcap ? mcap / rev : 0;   // dimensionless ratio

  return {
    ...row,
    loadError: null,
    name: metrics.name || row.name,
    sector: metrics.sector || row.sector,
    country: metrics.country || row.country,
    // Currency codes — essential for correct symbol display in the UI.
    // sharePrice is in the local exchange currency (e.g. INR for Indian stocks).
    // capitalGravity / revenueFlow / netYield are always in USD billions.
    currency: metrics.currency || row.currency || 'USD',
    financialCurrency: metrics.financialCurrency || row.financialCurrency || 'USD',
    usdRate: metrics.usdRate ?? row.usdRate ?? 1.0,
    website: metrics.website || row.website || null,
    logoUrl: metrics.logoUrl || row.logoUrl || null,
    finnhubLogo: metrics.finnhubLogo ?? row.finnhubLogo ?? null,
    capitalGravity: capB,
    revenueFlow: revB,
    netYield: netB ?? 0,
    valuationIndex: valIx,
    sharePrice: metrics.price ?? row.sharePrice,
    liquidityScore: metrics.liquidity ?? row.liquidityScore,
    growthMomentum: metrics.growth ?? row.growthMomentum,
    riskCoefficient: metrics.risk ?? row.riskCoefficient,
    efficiencyRatio:
      metrics.efficiency != null ? metrics.efficiency / 100 : row.efficiencyRatio,
    peRatio: metrics.pe ?? null,
    pbRatio: metrics.pb ?? null,
    debtEquity: metrics.de ?? null,
    roe: metrics.roe ?? null,
    roa: metrics.roa ?? null,
    beta: metrics.beta ?? null,
    sharpeRatio: metrics.sharpe ?? null,
    dividendYield: metrics.divYield ?? null,
    ebitdaMargin: metrics.ebitdaPct ?? null,
    fcfYield: metrics.fcfYield ?? null,
    dividendAnnual: metrics.dividendAnnual ?? row.dividendAnnual ?? null,
    payoutRatioPct: metrics.payoutRatioPct ?? row.payoutRatioPct ?? null,
    divYield5YAvg: metrics.divYield5YAvg ?? row.divYield5YAvg ?? null,
    exDividendDate: metrics.exDividendDate ?? row.exDividendDate ?? null,
    /** Trailing annual dividend per share in local price currency */
    dividendRate: metrics.dividendAnnual ?? row.dividendRate ?? null,
  };
}
