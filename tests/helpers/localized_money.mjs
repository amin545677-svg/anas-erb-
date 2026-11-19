export function parseLocalizedMoneyToMinorUnits(input, locale, fractionDigits = 2) {
  if (typeof input !== "string" || !input.trim()) throw new TypeError("money text is required");
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 6) throw new RangeError("invalid fractionDigits");
  const parts = new Intl.NumberFormat(locale, {useGrouping:true,minimumFractionDigits:fractionDigits,maximumFractionDigits:fractionDigits}).formatToParts(-1234567.89);
  const group=parts.find(p=>p.type==="group")?.value??"";
  const decimal=parts.find(p=>p.type==="decimal")?.value??".";
  const minus=parts.find(p=>p.type==="minusSign")?.value??"-";
  const digitFmt=new Intl.NumberFormat(locale,{useGrouping:false,maximumFractionDigits:0});
  const map=new Map();
  for(let n=0;n<=9;n++) map.set(digitFmt.formatToParts(n).filter(p=>p.type==="integer").map(p=>p.value).join(""),String(n));
  // Accept Arabic-Indic and Eastern Arabic-Indic input independently of the
  // locale's preferred numbering system (e.g. Arabic digits typed in fr-DZ).
  for (const [digits] of [["٠١٢٣٤٥٦٧٨٩"], ["۰۱۲۳۴۵۶۷۸۹"]]) {
    [...digits].forEach((glyph, index) => map.set(glyph, String(index)));
  }
  let value=input.normalize("NFKC");
  for(const [glyph,ascii] of map)value=value.split(glyph).join(ascii);
  if(group)value=value.split(group).join("");
  value=value.split("\\u066c").join("");
  value=value.split("\\u066b").join(decimal);
  value=value.split(minus).join("-").replace(/[\s\u00a0\u202f\u200e\u200f\u061c]/g,"");
  value=[...value].filter(ch=>/[0-9]/.test(ch)||ch===decimal||ch==="-").join("");
  const first=value.indexOf(decimal);
  if(first!==-1&&value.indexOf(decimal,first+decimal.length)!==-1)throw Error("multiple decimal separators");
  if(decimal!==".")value=value.replace(decimal,".");
  if(!/^-?\d+(?:\.\d+)?$/.test(value))throw Error("invalid localized amount");
  const neg=value.startsWith("-"), unsigned=neg?value.slice(1):value;
  const [whole,fraction=""]=unsigned.split(".");
  if(fraction.length>fractionDigits)throw Error("exceeds permitted precision");
  const units=BigInt(whole)*10n**BigInt(fractionDigits)+BigInt((fraction+"0".repeat(fractionDigits)).slice(0,fractionDigits)||"0");
  return neg?-units:units;
}
