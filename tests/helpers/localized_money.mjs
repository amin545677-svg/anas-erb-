export function parseLocalizedMoneyToMinorUnits(input, locale, fractionDigits = 2) {
  if (typeof input !== "string" || !input.trim()) throw new TypeError("money text is required");
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 6) throw new RangeError("invalid fractionDigits");

  const parts = new Intl.NumberFormat(locale, {
    useGrouping: true,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).formatToParts(-1234567.89);
  const localeGroup = parts.find(part => part.type === "group")?.value ?? "";
  const localeDecimal = parts.find(part => part.type === "decimal")?.value ?? ".";

  const digitFormatter = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 });
  const digits = new Map();
  for (let number = 0; number <= 9; number++) {
    const glyph = digitFormatter.formatToParts(number)
      .filter(part => part.type === "integer")
      .map(part => part.value)
      .join("");
    digits.set(glyph, String(number));
  }
  for (const alphabet of ["٠١٢٣٤٥٦٧٨٩", "۰۱۲۳۴۵۶۷۸۹"]) {
    [...alphabet].forEach((glyph, index) => digits.set(glyph, String(index)));
  }

  let value = input.normalize("NFKC");
  for (const [glyph, ascii] of digits) value = value.split(glyph).join(ascii);
  value = value.replace(/[\u200e\u200f\u061c]/g, "");
  value = value.replace(/[−﹣－]/g, "-");

  // UI text may be rendered with Arabic separators even when the test locale is
  // fr-DZ (or vice versa). Normalize all supported decimal glyphs, then choose
  // the rightmost separator whose fractional tail fits the requested precision.
  const separators = [".", ",", "\u066b"];
  const occurrences = [];
  for (const separator of separators) {
    let offset = value.indexOf(separator);
    while (offset !== -1) {
      occurrences.push({ separator, offset, tail: value.length - offset - separator.length });
      offset = value.indexOf(separator, offset + separator.length);
    }
  }
  const preferred = occurrences
    .filter(item => item.separator === localeDecimal && item.tail <= fractionDigits)
    .sort((a, b) => b.offset - a.offset)[0];
  const decimalMark = preferred?.separator
    ?? occurrences.filter(item => item.tail > 0 && item.tail <= fractionDigits)
      .sort((a, b) => b.offset - a.offset)[0]?.separator
    ?? null;

  const minusCount = (value.match(/-/g) || []).length;
  if (minusCount > 1 || (minusCount === 1 && !value.trimStart().startsWith("-"))) {
    throw new Error("invalid localized amount sign");
  }
  const negative = value.trimStart().startsWith("-");
  value = value.replace(/-/g, "");

  // Remove locale and Arabic grouping marks, whitespace, and currency text.
  const groupingMarks = new Set([localeGroup, "\u066c", "\u00a0", "\u202f", " ", "'", "’"]);
  for (const mark of groupingMarks) if (mark) value = value.split(mark).join("");

  let normalized = "";
  let decimalUsed = false;
  for (const character of value) {
    if (/[0-9]/.test(character)) {
      normalized += character;
    } else if (decimalMark && character === decimalMark && !decimalUsed) {
      normalized += ".";
      decimalUsed = true;
    }
  }
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error("invalid localized amount");

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > fractionDigits) throw new Error("exceeds permitted precision");
  const units = BigInt(whole) * 10n ** BigInt(fractionDigits)
    + BigInt((fraction + "0".repeat(fractionDigits)).slice(0, fractionDigits) || "0");
  return negative ? -units : units;
}
