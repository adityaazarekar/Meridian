"""Maps yfinance ticker.info + price history to Meridian dashboard JSON fields."""

from typing import Dict, Optional, Tuple

import datetime as _dt
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlparse

import pandas as pd
import yfinance as yf

_FINNHUB_LOGO_CACHE: Dict[str, Tuple[float, Optional[str]]] = {}

# ── FX RATE CACHE ─────────────────────────────────────────────────────────────
# Stores {currency_code: (fetch_timestamp, usd_rate)}
# Rate = how many USD one unit of that currency buys (e.g. INR → 0.012)
_FX_CACHE: Dict[str, Tuple[float, float]] = {}
_FX_TTL = 900  # 15 minutes


def _get_usd_rate(currency: str) -> float:
    """
    Return the exchange rate: 1 unit of `currency` = X USD.
    Uses yfinance FX tickers like INRUSD=X, EURUSD=X, etc.
    Falls back to 1.0 (treats as USD) if the rate cannot be fetched.
    Results are cached for 15 minutes per currency.
    """
    if not currency or currency.upper() == "USD":
        return 1.0
    code = currency.upper().strip()
    now = time.time()
    cached = _FX_CACHE.get(code)
    if cached and (now - cached[0]) < _FX_TTL:
        return cached[1]
    
    # 1. Try fetching the exchange rate using history (extremely reliable endpoint)
    try:
        ticker_sym = f"{code}USD=X"
        ticker = yf.Ticker(ticker_sym)
        hist = ticker.history(period="1d")
        if not hist.empty:
            rate = hist["Close"].iloc[-1]
            if rate and isinstance(rate, (int, float)) and rate > 0:
                _FX_CACHE[code] = (now, float(rate))
                return float(rate)
    except Exception:
        pass

    # 2. Fall back to the info endpoint
    try:
        ticker_sym = f"{code}USD=X"
        info = yf.Ticker(ticker_sym).info
        rate = (
            info.get("regularMarketPrice")
            or info.get("currentPrice")
            or info.get("price")
        )
        if rate and isinstance(rate, (int, float)) and rate > 0:
            _FX_CACHE[code] = (now, float(rate))
            return float(rate)
    except Exception:
        pass

    # 3. Fall back to a reverse lookup (e.g. USD/KRW)
    try:
        ticker_sym = f"USD{code}=X"
        ticker = yf.Ticker(ticker_sym)
        hist = ticker.history(period="1d")
        if not hist.empty:
            rate = hist["Close"].iloc[-1]
            if rate and isinstance(rate, (int, float)) and rate > 0:
                inv_rate = 1.0 / float(rate)
                _FX_CACHE[code] = (now, inv_rate)
                return inv_rate
    except Exception:
        pass

    # If fetch fails, cache a sentinel 1.0 for a short period to avoid hammering
    _FX_CACHE[code] = (now, 1.0)
    return 1.0



def _finnhub_logo(symbol: str) -> Optional[str]:
    """Company logo URL from Finnhub profile2 (cached ~2h per symbol)."""
    if not symbol:
        return None
    token = (os.environ.get("FINNHUB_TOKEN") or "").strip()
    if not token:
        return None
    key = symbol.upper().strip()
    now = time.time()
    hit = _FINNHUB_LOGO_CACHE.get(key)
    if hit and (now - hit[0]) < 7200:
        return hit[1]
    url = "https://finnhub.io/api/v1/stock/profile2?" + urllib.parse.urlencode(
        {"symbol": key, "token": token}
    )
    out = None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "MeridianAnalytics/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        logo = data.get("logo")
        if isinstance(logo, str) and logo.startswith("http"):
            out = logo
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
        out = None
    _FINNHUB_LOGO_CACHE[key] = (now, out)
    return out


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


def fmt_large(val, currency="USD"):
    """Format large numbers with the appropriate currency symbol."""
    v = safe(val)
    if v is None:
        return "N/A"
    # Always format in USD (values have already been converted)
    sym = "$"
    abs_v = abs(v)
    if abs_v >= 1e12:
        return f"{sym}{v/1e12:.1f}T"
    if abs_v >= 1e9:
        return f"{sym}{v/1e9:.1f}B"
    if abs_v >= 1e6:
        return f"{sym}{v/1e6:.1f}M"
    return f"{sym}{v:,.0f}"


def compute_metrics(info: dict, history_df) -> dict:
    """
    Maps yfinance ticker.info fields + history DataFrame
    to every field the Meridian Analytics dashboard displays.

    Currency handling:
      - financialCurrency: the currency of income statement / balance sheet data
        (totalRevenue, ebitda, netIncome, freeCashflow, marketCap)
      - currency: the trading currency of the share price
      All large monetary values are converted to USD using live FX rates
      before being returned. The original currency code is also returned
      so the frontend can display the correct symbol for the share price.
    """

    # ── CURRENCY DETECTION ────────────────────────────────────────────────────
    # financialCurrency covers P&L / balance sheet items
    financial_currency = (
        info.get("financialCurrency")
        or info.get("currency")
        or "USD"
    ).upper().strip()

    # price_currency covers the share price
    price_currency = (info.get("currency") or "USD").upper().strip()

    # Exchange rates to USD
    fin_usd_rate = _get_usd_rate(financial_currency)   # for marketCap, revenue, etc.
    price_usd_rate = _get_usd_rate(price_currency)     # for share price (informational)

    # ── RAW VALUES (in local currency) ────────────────────────────────────────
    price = safe(info.get("currentPrice") or info.get("regularMarketPrice"))
    prev_close = safe(info.get("previousClose") or info.get("regularMarketPreviousClose"))
    mkt_cap_local = safe(info.get("marketCap"))
    shares_out = safe(info.get("sharesOutstanding"))
    total_revenue_local = safe(info.get("totalRevenue"))
    ebitda_local = safe(info.get("ebitda"))
    ebitda_margins = safe(info.get("ebitdaMargins"))  # e.g. 0.329 = 32.9%  (ratio, no conversion needed)
    roe = safe(info.get("returnOnEquity"))             # ratio, no conversion needed
    roa = safe(info.get("returnOnAssets"))             # ratio, no conversion needed
    de = safe(info.get("debtToEquity"))                # ratio, no conversion needed
    beta_raw = safe(info.get("beta"))
    current_ratio = safe(info.get("currentRatio"))
    quick_ratio = safe(info.get("quickRatio"))
    free_cashflow_local = safe(info.get("freeCashflow"))
    revenue_growth = safe(info.get("revenueGrowth"))  # ratio, no conversion needed
    trailing_pe = safe(info.get("trailingPE"))
    forward_pe = safe(info.get("forwardPE"))
    price_to_book = safe(info.get("priceToBook"))
    div_yield_raw = safe(info.get("dividendYield"))   # ratio, no conversion needed
    trailing_eps = safe(info.get("trailingEps"))      # in price_currency (local)
    profit_margins = safe(info.get("profitMargins"))  # ratio, no conversion needed
    net_income_common_local = safe(info.get("netIncomeToCommon"))
    payout_ratio = safe(info.get("payoutRatio"))      # ratio
    dividend_rate = safe(info.get("dividendRate"))    # in price_currency (local per share)
    five_y_div = safe(info.get("fiveYearAvgDividendYield"))
    ex_div_raw = info.get("exDividendDate")

    # ── USD CONVERSION ────────────────────────────────────────────────────────
    # marketCap is shares * price, so it uses price_currency
    mkt_cap = (mkt_cap_local * price_usd_rate) if mkt_cap_local is not None else None
    total_revenue = (total_revenue_local * fin_usd_rate) if total_revenue_local is not None else None
    ebitda = (ebitda_local * fin_usd_rate) if ebitda_local is not None else None
    free_cashflow = (free_cashflow_local * fin_usd_rate) if free_cashflow_local is not None else None
    net_income_common = (net_income_common_local * fin_usd_rate) if net_income_common_local is not None else None

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

    _sym = (info.get("symbol") or "").strip()
    _fin_logo = _finnhub_logo(_sym) if _sym else None

    return {
        "name": info.get("longName") or info.get("shortName") or "",
        "ticker": info.get("symbol") or "",
        "sector": info.get("sector") or "Unknown",
        "industry": info.get("industry") or "Unknown",
        "country": info.get("country") or "Unknown",
        "exchange": info.get("exchange") or "",
        "description": info.get("longBusinessSummary") or "",
        "website": info.get("website") or "",
        "finnhubLogo": _fin_logo,
        "logoUrl": _logo_url(info.get("website") or ""),
        # ── Currency metadata ──────────────────────────────────────────────
        # currency: 3-letter code for the share price (e.g. "INR", "JPY", "EUR")
        # All raw monetary fields below are already converted to USD.
        "currency": price_currency,
        "financialCurrency": financial_currency,
        "usdRate": safe_round(fin_usd_rate, 6),
        # ── Dividend ───────────────────────────────────────────────────────
        "payoutRatioPct": payout_pct,
        "dividendAnnual": safe_round(dividend_rate),   # in local price currency per share
        "divYield5YAvg": div_yield_5y,
        "exDividendDate": _fmt_ex_dividend(ex_div_raw),
        # ── Price (in local price_currency) ───────────────────────────────
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
        # ── Formatted strings (USD-converted) ─────────────────────────────
        "capital": fmt_large(mkt_cap),
        "revenue": fmt_large(total_revenue),
        # ── Valuation ratios (dimensionless) ──────────────────────────────
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
        # ── Raw values (ALL converted to USD) ─────────────────────────────
        "raw": {
            "marketCap": safe_round(mkt_cap),           # USD
            "totalRevenue": safe_round(total_revenue),   # USD
            "ebitda": safe_round(ebitda),                # USD
            "freeCashflow": safe_round(free_cashflow),   # USD
            "netIncome": safe_round(net_income_common),  # USD
            "eps": safe_round(trailing_eps),             # local price currency (per share)
            "sharesOut": safe_round(shares_out),
            "currentRatio": safe_round(current_ratio),
            "quickRatio": safe_round(quick_ratio),
            "profitMargins": safe_round(profit_margins),
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
