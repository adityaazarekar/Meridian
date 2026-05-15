/** Strip exchange suffix for brand APIs (e.g. RELIANCE.NS → RELIANCE). */
export function symbolBaseForBranding(symbol) {
  if (!symbol || typeof symbol !== "string") return "";
  const u = symbol.trim().toUpperCase();
  const dot = u.lastIndexOf(".");
  if (dot <= 0) return u;
  return u.slice(0, dot);
}

const LOGO_DEV = import.meta.env.VITE_LOGO_DEV_TOKEN;

/**
 * Ordered logo URLs: logo.dev (env) → Finnhub → Clearbit → favicon CDNs.
 */
export function buildCompanyLogoCandidates(company) {
  const out = [];
  const rawSym = (company?.symbol || "").trim().toUpperCase();
  const baseSym = symbolBaseForBranding(rawSym);

  if (LOGO_DEV) {
    if (baseSym) {
      out.push(
        `https://img.logo.dev/ticker/${encodeURIComponent(baseSym)}.png?token=${encodeURIComponent(LOGO_DEV)}`
      );
    }
    if (rawSym && rawSym !== baseSym) {
      out.push(
        `https://img.logo.dev/ticker/${encodeURIComponent(rawSym)}.png?token=${encodeURIComponent(LOGO_DEV)}`
      );
    }
  }
  if (company?.finnhubLogo) out.push(company.finnhubLogo);
  if (company?.logoUrl) out.push(company.logoUrl);

  const host = parseWebsiteHost(company?.website);
  if (host) {
    out.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`);
    out.push(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`);
    out.push(`https://unavatar.io/${encodeURIComponent(host)}?fallback=false`);
  }
  return [...new Set(out.filter(Boolean))];
}

/** Extract registrable host from Yahoo `website` string. */
export function parseWebsiteHost(website) {
  if (!website || typeof website !== "string") return null;
  const w = website.trim();
  try {
    const u = new URL(w.includes("://") ? w : `https://${w}`);
    const h = u.hostname.replace(/^www\./i, "");
    return h && h.includes(".") ? h : null;
  } catch {
    return null;
  }
}
