import { useState } from "react";

/**
 * Brand mark via Clearbit Logo API from company website domain.
 * Falls back to ticker initials on failure / missing URL.
 */
export function CompanyLogo({ company, size = 28, radius = 8 }) {
  const [failed, setFailed] = useState(false);
  const src = !failed && company?.logoUrl ? company.logoUrl : null;
  const initials = (company?.symbol || "?").slice(0, 2).toUpperCase();

  if (!src) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: "linear-gradient(145deg, rgba(255,255,255,.12), rgba(255,255,255,.04))",
          border: "1px solid rgba(255,255,255,.1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.max(10, size * 0.32),
          fontWeight: 700,
          color: "#94a3b8",
          flexShrink: 0,
          fontFamily: "'DM Mono', monospace",
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
      style={{
        borderRadius: radius,
        objectFit: "contain",
        background: "#fff",
        border: "1px solid rgba(255,255,255,.12)",
        flexShrink: 0,
      }}
      onError={() => setFailed(true)}
    />
  );
}
