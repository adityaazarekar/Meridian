"""Maps yfinance ticker.info + price history to Meridian dashboard JSON fields."""

from typing import Optional

import datetime as _dt
import json
import math
from urllib.parse import urlparse

import pandas as pd


def _logo_url(website: str) -> Optional[str]:
    if not website or not isinstance(website, str):
        return None
    try:
        p = urlparse(website.strip())
        host = (p.netloc or "").lower()
        if not host and p.path:
            host = p.path.split("/")[0].lower()
        if host.startswith("www."):
            host = host[4:]
        if not host or "." not in host:
            return None
        return f"https://logo.clearbit.com/{host}"
    except Exception:
        return None


def _fmt_ex_dividend(val) -> Optional[str]:
    if val is None:
        return None
    try:
        if isinstance(val, (int, float)) and val > 1e8:
            return _dt.datetime.utcfromtimestamp(int(val)).strftime("%Y-%m-%d")
        if isinstance(val, str) and len(val) >= 10:
            return val[:10]
        return str(val)[:32]
    except Exception:
        return None


def safe(val, fallback=None):
    """Return fallback if val is None, NaN, or infinite."""
    try:
        if val is None:
            return fallback
        f = float(val)
        if f != f or abs(f) == float("inf"):  # NaN or Inf check
            return fallback
        return f
    except (TypeError, ValueError):
        return fallback


def safe_round(val, digits=2, fallback=None):
    v = safe(val, fallback)
    if v is None:
        return None
    return round(v, digits)


def fmt_large(val):
    """Format large numbers: 2689900000 → '$2689.9B'"""
    v = safe(val)
    if v is None:
        return "N/A"
    abs_v = abs(v)
    if abs_v >= 1e12:
        return f"${v/1e12:.1f}T"
    if abs_v >= 1e9:
        return f"${v/1e9:.1f}B"
    if abs_v >= 1e6:
        return f"${v/1e6:.1f}M"
    return f"${v:,.0f}"


def compute_metrics(info: dict, history_df) -> dict:
    """
    Maps yfinance ticker.info fields + history DataFrame
    to every field the Meridian Analytics dashboard displays.

    yfinance field reference (exact keys from ticker.info):
      currentPrice, previousClose, open, dayHigh, dayLow
      fiftyTwoWeekHigh, fiftyTwoWeekLow, volume, averageVolume
      marketCap, sharesOutstanding
      trailingPE, forwardPE                  → pe
      priceToBook                            → pb
      dividendYield                          → divYield
      trailingEps, forwardEps               → eps
      beta                                   → beta
      totalRevenue                           → revenue (raw)
      ebitda                                 → ebitda (raw)
      ebitdaMargins                          → ebitdaPct (direct %)
      returnOnEquity                         → roe (decimal, ×100 for %)
      returnOnAssets                         → roa (decimal, ×100 for %)
      debtToEquity                           → de
      currentRatio                           → currentRatio (for liquidity score)
      quickRatio                             → quickRatio
      freeCashflow                           → fcfYield numerator
      revenueGrowth                          → growth (decimal, ×100 for %)
      earningsGrowth                         → earningsGrowth
      shortName, longName                    → name
      sector, industry                       → sector
      country                                → country
      website, longBusinessSummary           → website, description
      logo_url (not in info — omit)
    """

    # ── RAW VALUES ────────────────────────────────────────────────────────────
    price = safe(info.get("currentPrice") or info.get("regularMarketPrice"))
    prev_close = safe(info.get("previousClose") or info.get("regularMarketPreviousClose"))
    mkt_cap = safe(info.get("marketCap"))
    shares_out = safe(info.get("sharesOutstanding"))
    total_revenue = safe(info.get("totalRevenue"))
    ebitda = safe(info.get("ebitda"))
    ebitda_margins = safe(info.get("ebitdaMargins"))  # e.g. 0.329 = 32.9%
    roe = safe(info.get("returnOnEquity"))  # e.g. 1.479 = 147.9%
    roa = safe(info.get("returnOnAssets"))  # e.g. 0.195 = 19.5%
    de = safe(info.get("debtToEquity"))  # e.g. 195.87
    beta_raw = safe(info.get("beta"))
    current_ratio = safe(info.get("currentRatio"))
    quick_ratio = safe(info.get("quickRatio"))
    free_cashflow = safe(info.get("freeCashflow"))
    revenue_growth = safe(info.get("revenueGrowth"))  # e.g. -0.055 = -5.5%
    trailing_pe = safe(info.get("trailingPE"))
    forward_pe = safe(info.get("forwardPE"))
    price_to_book = safe(info.get("priceToBook"))
    div_yield_raw = safe(info.get("dividendYield"))  # e.g. 0.0053 = 0.53%
    trailing_eps = safe(info.get("trailingEps"))
    profit_margins = safe(info.get("profitMargins"))
    net_income_common = safe(info.get("netIncomeToCommon"))
    payout_ratio = safe(info.get("payoutRatio"))
    dividend_rate = safe(info.get("dividendRate"))
    five_y_div = safe(info.get("fiveYearAvgDividendYield"))
    ex_div_raw = info.get("exDividendDate")

    # ── PRICE CHANGE ──────────────────────────────────────────────────────────
    change = safe_round((price - prev_close) if price and prev_close else None)
    change_pct = safe_round(
        ((price - prev_close) / prev_close * 100)
        if price and prev_close and prev_close != 0
        else None
    )

    # ── VALUATION ─────────────────────────────────────────────────────────────
    pe = safe_round(trailing_pe or forward_pe)
    pb = safe_round(price_to_book)
    div_yield = safe_round(div_yield_raw * 100 if div_yield_raw is not None else None)
    payout_pct = safe_round(payout_ratio * 100 if payout_ratio is not None else None)
    div_yield_5y = safe_round(five_y_div * 100 if five_y_div is not None else None)
    fcf_yield = safe_round(
        (free_cashflow / mkt_cap * 100) if free_cashflow and mkt_cap and mkt_cap != 0 else None
    )

    # ── PROFITABILITY ─────────────────────────────────────────────────────────
    roe_pct = safe_round(roe * 100 if roe is not None else None)
    roa_pct = safe_round(roa * 100 if roa is not None else None)

    if ebitda_margins is not None:
        ebitda_pct = safe_round(ebitda_margins * 100)
    elif ebitda and total_revenue and total_revenue != 0:
        ebitda_pct = safe_round(ebitda / total_revenue * 100)
    else:
        ebitda_pct = None

    # ── LEVERAGE & RISK ───────────────────────────────────────────────────────
    de_ratio = safe_round(de / 100 if de is not None else None)
    beta_val = safe_round(beta_raw)

    sharpe = None
    if history_df is not None and len(history_df) >= 20:
        try:
            series = (
                history_df["Close"]
                if "Close" in history_df.columns
                else history_df.iloc[:, -1]
            )
            if isinstance(series, pd.DataFrame):
                series = series.iloc[:, 0]
            daily_returns = series.pct_change().dropna()
            mean_daily = daily_returns.mean()
            std_daily = daily_returns.std()
            risk_free_daily = 0.045 / 252
            if std_daily is not None and std_daily != 0 and not (isinstance(std_daily, float) and math.isnan(std_daily)):
                sharpe = safe_round(
                    (float(mean_daily) - risk_free_daily) / float(std_daily) * (252**0.5)
                )
        except Exception:
            sharpe = None

    # ── COMPOSITE SCORES (0–100) ──────────────────────────────────────────────
    if current_ratio is not None:
        liquidity = safe_round(min(current_ratio * 50, 100))
    else:
        liquidity = None

    op_margins = safe(info.get("operatingMargins"))
    if op_margins is not None:
        efficiency = safe_round(min(max(op_margins * 100, 0), 100))
    else:
        efficiency = None

    growth = safe_round(revenue_growth * 100 if revenue_growth is not None else None)

    if beta_val is not None:
        risk_components = (beta_val or 1) * 20
        if de_ratio is not None:
            risk_components += de_ratio * 10
        if current_ratio and current_ratio != 0:
            risk_components += (1 / current_ratio) * 10
        else:
            risk_components += 20
        risk_score = safe_round(min(max(risk_components, 0), 100))
    else:
        risk_score = None

    return {
        "name": info.get("longName") or info.get("shortName") or "",
        "ticker": info.get("symbol") or "",
        "sector": info.get("sector") or "Unknown",
        "industry": info.get("industry") or "Unknown",
        "country": info.get("country") or "Unknown",
        "exchange": info.get("exchange") or "",
        "description": info.get("longBusinessSummary") or "",
        "website": info.get("website") or "",
        "logoUrl": _logo_url(info.get("website") or ""),
        "payoutRatioPct": payout_pct,
        "dividendAnnual": safe_round(dividend_rate),
        "divYield5YAvg": div_yield_5y,
        "exDividendDate": _fmt_ex_dividend(ex_div_raw),
        "price": safe_round(price),
        "prevClose": safe_round(prev_close),
        "open": safe_round(safe(info.get("open") or info.get("regularMarketOpen"))),
        "high": safe_round(safe(info.get("dayHigh") or info.get("regularMarketDayHigh"))),
        "low": safe_round(safe(info.get("dayLow") or info.get("regularMarketDayLow"))),
        "high52": safe_round(safe(info.get("fiftyTwoWeekHigh"))),
        "low52": safe_round(safe(info.get("fiftyTwoWeekLow"))),
        "volume": int(safe(info.get("volume") or info.get("regularMarketVolume"), 0)),
        "avgVolume": int(safe(info.get("averageVolume"), 0)),
        "change": change,
        "changePct": change_pct,
        "capital": fmt_large(mkt_cap),
        "revenue": fmt_large(total_revenue),
        "pe": pe,
        "pb": pb,
        "divYield": div_yield,
        "fcfYield": fcf_yield,
        "roe": roe_pct,
        "roa": roa_pct,
        "ebitdaPct": ebitda_pct,
        "de": de_ratio,
        "beta": beta_val,
        "sharpe": sharpe,
        "liquidity": liquidity,
        "efficiency": efficiency,
        "growth": growth,
        "risk": risk_score,
        "raw": {
            "marketCap": safe_round(mkt_cap),
            "totalRevenue": safe_round(total_revenue),
            "ebitda": safe_round(ebitda),
            "freeCashflow": safe_round(free_cashflow),
            "eps": safe_round(trailing_eps),
            "sharesOut": safe_round(shares_out),
            "currentRatio": safe_round(current_ratio),
            "quickRatio": safe_round(quick_ratio),
            "profitMargins": safe_round(profit_margins),
            "netIncome": safe_round(net_income_common),
        },
    }


def sanitize_for_json(obj):
    """Recursively replace NaN/Inf with None for JSON."""
    if isinstance(obj, dict):
        return {k: sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_for_json(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
    return obj


def history_to_list(df):
    """Convert pandas DataFrame to list of dicts for JSON serialisation."""
    if df is None or df.empty:
        return []
    out = df.copy()
    if isinstance(out.columns, pd.MultiIndex):
        out.columns = [c[0] if isinstance(c, tuple) else c for c in out.columns]
    out = out.reset_index()
    date_col = "Date" if "Date" in out.columns else out.columns[0]
    out[date_col] = out[date_col].astype(str)
    records = json.loads(out.to_json(orient="records", date_format="iso"))
    return sanitize_for_json(records)
