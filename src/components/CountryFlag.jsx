import { useMemo, useState } from "react";
import { countryToIso2 } from "../utils/countryIso";

/**
 * Small circular flag from flagcdn (no API key). Falls back to neutral globe.
 */
export function CountryFlag({ country, size = 20, title }) {
  const iso = useMemo(() => countryToIso2(country), [country]);
  const [err, setErr] = useState(false);
  const px = Math.round(size * 2);
  const src = iso && !err ? `https://flagcdn.com/w${Math.min(px, 80)}/${iso}.png` : null;
  const label = title || country || "";

  if (!src) {
    return (
      <span
        className="country-flag-fallback"
        title={label}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.max(10, size * 0.55),
          background: "linear-gradient(145deg, rgba(255,255,255,.1), rgba(255,255,255,.03))",
          border: "1px solid rgba(255,255,255,.12)",
          flexShrink: 0,
        }}
        aria-hidden
      >
        🌐
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      title={label}
      className="country-flag-img"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        border: "1px solid rgba(255,255,255,.14)",
        boxShadow: "0 2px 8px rgba(0,0,0,.35)",
        flexShrink: 0,
      }}
      onError={() => setErr(true)}
    />
  );
}
