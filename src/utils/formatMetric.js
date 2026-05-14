/** Display helper — null/NaN → "N/A". */
export function fmt(val, suffix = '', prefix = '') {
  if (val == null || (typeof val === 'number' && Number.isNaN(val))) {
    return 'N/A';
  }
  return `${prefix}${val}${suffix}`;
}

/** Numeric display with fixed decimals; null/NaN → "N/A". */
export function fmtNum(val, decimals, suffix = '', prefix = '') {
  if (val == null || (typeof val === 'number' && Number.isNaN(val))) {
    return 'N/A';
  }
  return `${prefix}${Number(val).toFixed(decimals)}${suffix}`;
}
