/** Simple EMA over numeric series (same length as input). */
export function emaSeries(values, span) {
  if (!values?.length || span < 1) return [];
  const k = 2 / (span + 1);
  const out = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) {
      out.push(null);
      continue;
    }
    if (i === 0) prev = v;
    else prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder-style RSI (14) aligned to closes; leading values null. */
export function rsiSeries(closes, period = 14) {
  const out = closes.map(() => null);
  if (!closes?.length || period < 1) return out;
  for (let i = period; i < closes.length; i++) {
    let gains = 0;
    let losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const ch = closes[j] - closes[j - 1];
      if (ch >= 0) gains += ch;
      else losses -= ch;
    }
    const avgG = gains / period;
    const avgL = losses / period || 1e-12;
    const rs = avgG / avgL;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}
