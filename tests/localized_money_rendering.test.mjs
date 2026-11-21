import test from "node:test";
import assert from "node:assert/strict";
import {parseLocalizedMoneyToMinorUnits as parse} from "./helpers/localized_money.mjs";
test("ICU locale parsing is stable across Arabic, French, German and US formats",()=>{
 for(const [locale,text] of [
  ["fr-DZ","18\u202f999,50 دج"],["de-DE","18.999,50 €"],["en-US","$18,999.50"],
  ["ar-DZ","١٨٬٩٩٩٫٥٠ دج"],["ar-EG","١٨٬٩٩٩٫٥٠ ج.م.‏"]
 ]) assert.equal(parse(text,locale),1899950n,locale);
});
test("malformed and excessive precision are rejected",()=>{
 assert.throws(()=>parse("1,2,3","fr-FR"));
 assert.throws(()=>parse("1.234","en-US"),/precision/);
 assert.throws(()=>parse("","fr-DZ"),/required/);
});
