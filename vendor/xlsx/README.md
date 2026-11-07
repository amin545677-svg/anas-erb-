# SheetJS Community Edition

- Version: 0.20.3
- Browser bundle: `xlsx.full.min.js`
- Upstream distribution: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
- License: Apache-2.0 (see `LICENSE`)
- Upstream Git blob SHA-1: `21471af69ef0e4cda1613c2702c54101b92f48d2`

The bundle is vendored so Excel import/export works without a runtime CDN dependency.

The upstream bundle contains U+FFFD glyphs in legacy code-page lookup tables. In the vendored copy those glyphs are represented as JavaScript `\\uFFFD` escapes; the runtime string values are unchanged while the source remains clean UTF-8.
