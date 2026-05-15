import { useMemo, useState, useEffect } from "react";
import { buildCompanyLogoCandidates } from "../utils/logoUrls";

/**
 * Brand mark: logo.dev (optional) → Finnhub → Clearbit → favicons → initials.
 * Final fallback: polished ticker chip.
 */
export function CompanyLogo({ company, size = 28, radius = 8 }) {
  const candidates = useMemo(() => buildCompanyLogoCandidates(company), [company?.logoUrl, company?.finnhubLogo, company?.website, company?.symbol]);
  const [idx, setIdx] = useState(0);
  const src = candidates[idx] ?? null;
  const initials = (company?.symbol || "?").slice(0, 2).toUpperCase();

  useEffect(() => {
    setIdx(0);
  }, [candidates]);

  if (!src || idx >= candidates.length) {
    return (
      <div
        className="company-logo-fallback"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: "linear-gradient(145deg, rgba(232,184,75,.22), rgba(15,23,42,.9))",
          border: "1px solid rgba(232,184,75,.28)",
          boxShadow: "0 4px 14px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.12)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.max(10, size * 0.32),
          fontWeight: 700,
          color: "#e8e4dc",
          flexShrink: 0,
          fontFamily: "'DM Mono', ui-monospace, monospace",
          letterSpacing: "-0.04em",
        }}
      >
        {initials}
      </div>
    );
  }

  return (
    <img
      alt=""
      src={src}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      className="company-logo-img"
      style={{
        borderRadius: radius,
        objectFit: "contain",
        background: "linear-gradient(180deg, #1e293b, #0f172a)",
        border: "1px solid rgba(232,184,75,.2)",
        boxShadow: "0 6px 18px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08)",
        flexShrink: 0,
      }}
      onError={() => setIdx((i) => i + 1)}
    />
  );
}
