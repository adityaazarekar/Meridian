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

/**
 * Map ISO 4217 currency codes to display symbols.
 * Covers every exchange in the Meridian ticker list.
 */
const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  HKD: 'HK$',
  INR: '₹',
  KRW: '₩',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  CHF: 'Fr',
  DKK: 'kr',
  NOK: 'kr',
  SEK: 'kr',
  BRL: 'R$',
  MXN: 'MX$',
  ZAR: 'R',
  TWD: 'NT$',
  THB: '฿',
  MYR: 'RM',
  IDR: 'Rp',
  PHP: '₱',
  VND: '₫',
  TRY: '₺',
  SAR: '﷼',
  AED: 'AED',
  QAR: 'QR',
};

/**
 * Returns the currency symbol for a given ISO 4217 code.
 * Falls back to the code itself (e.g. "CHF") or "$" if unknown.
 */
export function getCurrencySymbol(code) {
  if (!code) return '$';
  return CURRENCY_SYMBOLS[code.toUpperCase()] || code.toUpperCase();
}

/**
 * Format a share price with its local currency symbol.
 * e.g. fmtLocalPrice(2453.5, 'INR') → '₹2453.50'
 *      fmtLocalPrice(180.25, 'USD') → '$180.25'
 */
export function fmtLocalPrice(val, currencyCode, decimals = 2) {
  if (val == null || (typeof val === 'number' && Number.isNaN(val))) {
    return 'N/A';
  }
  const sym = getCurrencySymbol(currencyCode);
  return `${sym}${Number(val).toFixed(decimals)}`;
}

/**
 * Format a USD-normalised monetary value in billions/trillions.
 * e.g. fmtUsdBn(3500) → '$3.50T'
 *      fmtUsdBn(42.3) → '$42.3B'
 */
export function fmtUsdBn(bn) {
  if (bn == null || (typeof bn === 'number' && (Number.isNaN(bn) || !Number.isFinite(bn)))) {
    return 'N/A';
  }
  const v = Number(bn);
  if (v >= 1000) return `$${(v / 1000).toFixed(2)}T`;
  return `$${v.toFixed(1)}B`;
}
