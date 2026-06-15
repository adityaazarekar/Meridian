import os

import yfinance as yf
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from compute_metrics import compute_metrics, history_to_list, sanitize_for_json

# ── STATIC FRONTEND SERVING ───────────────────────────────────────────────────
# In production (Render), Flask serves the Vite build from the dist/ folder
# which lives one level above the backend/ directory.
# In local dev, the Vite dev server (localhost:5173) handles the frontend.
_DIST_DIR = os.path.join(os.path.dirname(__file__), "..", "dist")
_SERVE_FRONTEND = os.path.isdir(_DIST_DIR)

app = Flask(
    __name__,
    static_folder=_DIST_DIR if _SERVE_FRONTEND else None,
    static_url_path="",
)

_origins = [
    "http://localhost:5173",
    "http://localhost:3000",
]
_fe = os.environ.get("FRONTEND_URL")
if _fe and _fe.strip() and _fe.strip() != "*":
    _origins.append(_fe.strip())

# Allow all origins for the public API routes to prevent CORS blocks on Vercel
CORS(app, resources={r"/api/*": {"origins": "*"}})


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/stock/<ticker>")
def get_stock(ticker):
    """
    Returns full company data + OHLCV history.
    Ticker supports global suffixes: RELIANCE.NS, BMW.DE, HSBA.L, 7203.T etc.
    """
    try:
        period = request.args.get("period", "3mo")
        interval = request.args.get("interval", "1d")

        stock = yf.Ticker(ticker.upper())
        info = stock.info or {}

        if not info.get("regularMarketPrice") and not info.get("currentPrice"):
            if len(info) < 3:
                return (
                    jsonify(
                        {"error": f"Ticker '{ticker}' not found or no data available"}
                    ),
                    404,
                )

        history = stock.history(period=period, interval=interval)
        metrics = sanitize_for_json(compute_metrics(info, history))
        chart = history_to_list(history)

        return jsonify({"metrics": metrics, "chart": chart})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/live-search")
def live_search():
    """
    Live company search via Yahoo Finance.
    Query param: q (company name or ticker symbol)
    Returns up to 10 matching equities/ETFs with basic metadata.
    """
    q = (request.args.get("q") or "").strip()
    if not q or len(q) < 1:
        return jsonify([])

    try:
        search = yf.Search(q, max_results=15, news_count=0)
        quotes = search.quotes or []

        results = []
        for item in quotes:
            # Filter to tradeable securities only (skip futures, currencies, etc.)
            q_type = (item.get("quoteType") or "").upper()
            if q_type not in ("EQUITY", "ETF", "MUTUALFUND", ""):
                continue

            symbol = item.get("symbol") or ""
            name = (
                item.get("longname")
                or item.get("shortname")
                or item.get("longName")
                or item.get("shortName")
                or symbol
            )
            exchange = item.get("exchange") or item.get("exchDisp") or ""
            sector = item.get("sector") or item.get("sectorDisp") or ""
            industry = item.get("industry") or item.get("industryDisp") or ""
            score = item.get("score") or 0

            results.append({
                "symbol": symbol,
                "name": name,
                "exchange": exchange,
                "type": q_type,
                "sector": sector,
                "industry": industry,
                "score": score,
            })

            if len(results) >= 10:
                break

        return jsonify(results)

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stock-metrics/<ticker>")
def get_stock_metrics(ticker):
    """
    Returns company metrics (no chart) for a single ticker.
    Used after picking a company from live search results.
    """
    try:
        stock = yf.Ticker(ticker.upper())
        info = stock.info or {}

        if not info.get("regularMarketPrice") and not info.get("currentPrice"):
            if len(info) < 3:
                return jsonify({"error": f"Ticker '{ticker}' not found"}), 404

        history = stock.history(period="3mo", interval="1d")
        metrics = sanitize_for_json(compute_metrics(info, history))
        chart = history_to_list(history)
        return jsonify({"metrics": metrics, "chart": chart})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/search")
def search_stocks():
    GLOBAL_TICKERS = {
        "United States": [
            "AAPL",
            "MSFT",
            "GOOGL",
            "AMZN",
            "NVDA",
            "META",
            "TSLA",
            "JPM",
            "V",
            "WMT",
            "CL",
            "JNJ",
            "PG",
            "KO",
            "PEP",
            "MCD",
            "DIS",
            "NFLX",
            "INTC",
            "AMD",
        ],
        "India": [
            "RELIANCE.NS",
            "TCS.NS",
            "HDFCBANK.NS",
            "INFY.NS",
            "HINDUNILVR.NS",
            "ICICIBANK.NS",
            "SBIN.NS",
            "BAJFINANCE.NS",
        ],
        "United Kingdom": [
            "HSBA.L",
            "BP.L",
            "SHEL.L",
            "AZN.L",
            "GSK.L",
            "ULVR.L",
            "RIO.L",
            "BT-A.L",
        ],
        "Germany": ["BMW.DE", "SAP.DE", "SIE.DE", "DTE.DE", "BAS.DE", "MBG.DE", "ALV.DE"],
        "Japan": ["7203.T", "6758.T", "9432.T", "8306.T", "6861.T", "9984.T"],
        "China": ["0700.HK", "9988.HK", "3690.HK", "1299.HK", "2318.HK"],
        "Canada": ["RY.TO", "TD.TO", "BNS.TO", "CNR.TO", "ENB.TO", "SU.TO"],
        "Australia": ["CBA.AX", "BHP.AX", "CSL.AX", "NAB.AX", "WBC.AX", "ANZ.AX"],
        "France": ["MC.PA", "OR.PA", "TTE.PA", "SAN.PA", "BNP.PA", "AIR.PA"],
        "South Korea": ["005930.KS", "000660.KS", "035420.KS", "005380.KS"],
    }
    return jsonify(GLOBAL_TICKERS)


@app.route("/api/batch")
def batch_quotes():
    """
    Metrics for multiple tickers (dashboard tables). Max 20 per request.
    """
    tickers_param = request.args.get("tickers", "")
    if not tickers_param:
        return jsonify({"error": "No tickers provided"}), 400

    tickers = [t.strip().upper() for t in tickers_param.split(",") if t.strip()][:20]
    results = {}

    for t in tickers:
        try:
            stock = yf.Ticker(t)
            info = stock.info or {}
            if not info.get("regularMarketPrice") and not info.get("currentPrice"):
                if len(info) < 3:
                    results[t] = {"error": f"Ticker '{t}' not found or no data available"}
                    continue
            history = stock.history(period="3mo", interval="1d")
            metrics = sanitize_for_json(compute_metrics(info, history))
            results[t] = metrics
        except Exception as e:
            results[t] = {"error": str(e)}

    return jsonify(results)


# ── FRONTEND CATCH-ALL ─────────────────────────────────────────────────────────
# Must be defined LAST so it doesn't shadow any API routes.
# Serves the React SPA for any path that isn't an API route.
# Only active when the dist/ build folder is present (production).
if _SERVE_FRONTEND:
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_frontend(path):
        # Serve a real static file if it exists (JS chunks, CSS, images, etc.)
        full = os.path.join(_DIST_DIR, path)
        if path and os.path.isfile(full):
            return send_from_directory(_DIST_DIR, path)
        # Fall back to index.html so React Router handles the URL client-side
        return send_from_directory(_DIST_DIR, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
