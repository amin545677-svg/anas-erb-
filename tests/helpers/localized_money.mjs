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

  // Strip currency labels and grouping whitespace before measuring the
  // fractional tail; suffixes such as "دج" must not invalidate a decimal.
  if (localeGroup) value = value.split(localeGroup).join("");
  value = value.replace(/[\s\u066c'’]/g, "");
  value = [...value].filter(character => /[0-9]/.test(character)
    || character === "." || character === "," || character === "\u066b" || character === "-").join("");

  // The UI may use Arabic separators even when the test locale is fr-DZ.
  const separators = [".", ",", "\u066b"];

  // DOM containers can include labels and dates alongside the rendered amount.
  // Select the final decimal-bearing numeric token instead of treating every
  // unrelated hyphen/date digit as part of the money value.
  const numericTokens = value.match(/-?\d+(?:[.,\u066b]\d+)*/g) || [];
  if (numericTokens.length > 1) {
    const decimalTokens = numericTokens.filter(token => {
      const mark = [...token].find(character => separators.includes(character));
      if (!mark) return false;
      const tail = token.length - token.lastIndexOf(mark) - 1;
      return tail > 0 && tail <= fractionDigits;
    });
    if (decimalTokens.length) value = decimalTokens[decimalTokens.length - 1];
  }

  const occurrences = [];
  for (const separator of separators) {
    let offset = value.indexOf(separator);
    while (offset !== -1) {
      occurrences.push({ separator, offset, tail: value.length - offset - separator.length });
      offset = value.indexOf(separator, offset + separator.length);
    }
  }
  const localeOccurrences = occurrences.filter(item => item.separator === localeDecimal);
  if (localeOccurrences.length > 1) throw new Error("multiple decimal separators");
  const preferred = localeOccurrences.sort((a, b) => b.offset - a.offset)[0];
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
