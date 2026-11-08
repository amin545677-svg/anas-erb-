import fs from 'node:fs';
import vm from 'node:vm';
const file = 'index.html';
let html = fs.readFileSync(file, 'utf8');
const before = Buffer.byteLength(html, 'utf8');
const startMarker = '        function renderQuickProducts() {';
const endMarker = '        function anasCalculateExecutiveAnalytics';
let start = html.indexOf(startMarker);
let end = html.indexOf(endMarker, start);
if (start < 0 || end < 0 || html.indexOf(startMarker, start + 1) >= 0) throw new Error('POS_RENDER_FUNCTION_ANCHOR_NOT_UNIQUE');

if (!html.includes('id="anasPosProductViewToggle"')) {
  const anchor = '            <!-- شبكة أزرار السلع السريعة المباشرة -->';
  if (html.split(anchor).length !== 2) throw new Error('POS_VIEW_TOGGLE_ANCHOR_NOT_UNIQUE');
  const toolbar = '            <div id="anasPosProductViewToggle" class="anas-pos-view-toggle" role="group" aria-label="طريقة عرض المنتجات">\n' +
    '                <span>عرض المنتجات</span>\n' +
    '                <button type="button" id="anasPosListViewBtn" aria-pressed="true" onclick="setAnasPosProductView(\'list\')">☷ قائمة</button>\n' +
    '                <button type="button" id="anasPosGridViewBtn" aria-pressed="false" onclick="setAnasPosProductView(\'grid\')">▦ شبكة</button>\n' +
    '            </div>\n' + anchor;
  html = html.replace(anchor, toolbar);
}

start = html.indexOf(startMarker);
end = html.indexOf(endMarker, start);
if (start < 0 || end < 0 || html.indexOf(startMarker, start + 1) >= 0) throw new Error('POS_RENDER_FUNCTION_ANCHOR_LOST_AFTER_MARKUP_EDIT');

const replacement = [
'        // POS catalogue presentation: list by default, optional grid; cart and ledger remain canonical.',
'        function setAnasPosProductView(mode) {',
"            if (!['list', 'grid'].includes(mode)) return;",
'            window.__anasPosProductViewMode = mode;',
"            try { localStorage.setItem('ANAS_POS_PRODUCT_VIEW_V1', mode); } catch (_) {}",
"            const listButton = document.getElementById('anasPosListViewBtn');",
"            const gridButton = document.getElementById('anasPosGridViewBtn');",
"            if (listButton) listButton.setAttribute('aria-pressed', mode === 'list' ? 'true' : 'false');",
"            if (gridButton) gridButton.setAttribute('aria-pressed', mode === 'grid' ? 'true' : 'false');",
"            const container = document.getElementById('quickProductsContainer');",
"            if (container) { container.classList.toggle('anas-pos-products-list', mode === 'list'); container.classList.toggle('anas-pos-products-grid', mode === 'grid'); }",
'            renderQuickProducts();',
'        }',
'',
'        function renderQuickProducts() {',
"            const cont = document.getElementById('quickProductsContainer');",
'            if (!cont) return;',
'            const products = Array.isArray(AppData.products) ? AppData.products : [];',
'            const core = window.ANASMicroPOSCore;',
'            const selectedCategory = currentPosCategoryFilter;',
"            const warehouse = typeof wtCurrentSaleWarehouse === 'function' ? wtCurrentSaleWarehouse() : 'المخزن الرئيسي';",
'            const withSaleStock = products.map(p => ({ ...p, stock: Number(typeof wtAvailableStock === \'function\' ? wtAvailableStock(p, warehouse) : (p.stock ?? p.quantity ?? 0)), is_featured: !!(p.is_featured || p.featured || p.favorite || p.isFavorite) }));',
'            const filtered = core ? core.filterInventoryItems(withSaleStock, { category: selectedCategory === \'الكل\' ? \'ALL\' : selectedCategory, status: currentPosStockFilter === \'favorite\' ? \'featured\' : currentPosStockFilter }) : withSaleStock;',
'            let mode = window.__anasPosProductViewMode;',
"            if (!['list', 'grid'].includes(mode)) { try { mode = localStorage.getItem('ANAS_POS_PRODUCT_VIEW_V1'); } catch (_) {} }",
"            if (!['list', 'grid'].includes(mode)) mode = 'list';",
'            window.__anasPosProductViewMode = mode;',
"            cont.classList.toggle('anas-pos-products-list', mode === 'list');",
"            cont.classList.toggle('anas-pos-products-grid', mode === 'grid');",
"            const listButton = document.getElementById('anasPosListViewBtn');",
"            const gridButton = document.getElementById('anasPosGridViewBtn');",
"            if (listButton) listButton.setAttribute('aria-pressed', mode === 'list' ? 'true' : 'false');",
"            if (gridButton) gridButton.setAttribute('aria-pressed', mode === 'grid' ? 'true' : 'false');",
"            const money = value => Number(value).toLocaleString('fr-DZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' DA';",
"            const quantity = value => Number(value).toLocaleString('fr-DZ', { maximumFractionDigits: 3 });",
'            const renderCard = p => {',
'                const tier = Number(AppData.activePriceTier) || 1;',
'                const pr = tier === 2 ? (p.price2 ?? p.price1) : (tier === 3 ? (p.price3 ?? p.price1) : p.price1);',
"                const rawStock = Number(typeof wtAvailableStock === 'function' ? wtAvailableStock(p, warehouse) : (p.stock ?? p.quantity ?? 0));",
'                const stock = Number.isFinite(rawStock) ? rawStock : 0;',
'                const isOut = stock <= 0;',
'                const isLow = !isOut && stock <= (Number(p.minAlert ?? p.min_limit) || 5);',
"                const card = document.createElement('button');",
"                card.type = 'button';",
"                card.className = 'quick-product-btn anas-pos-product-card';",
'                card.dataset.posProductView = mode;',
"                card.dataset.productId = String(p.id ?? '');",
"                card.style.borderInlineStart = isOut ? '4px solid #ef4444' : (isLow ? '4px solid #f59e0b' : '4px solid #16a34a');",
"                card.setAttribute('aria-label', 'اختيار سعر ' + String(p.name || 'المنتج'));",
"                const info = document.createElement('span'); info.className = 'anas-pos-product-info';",
"                const name = document.createElement('strong'); name.className = 'anas-pos-product-name'; name.textContent = String(p.name ?? 'منتج بلا اسم');",
"                const barcode = document.createElement('small'); barcode.className = 'anas-pos-product-barcode'; barcode.textContent = 'باركود: ' + String(p.barcode ?? p.sku ?? p.code ?? '—');",
"                const stockBadge = document.createElement('span'); stockBadge.className = 'anas-pos-stock-badge ' + (isOut ? 'is-out' : (isLow ? 'is-low' : 'is-available'));",
"                stockBadge.textContent = (isOut ? '⚠ ' : '') + quantity(stock) + ' ' + String(p.unit || 'قطعة');",
'                info.append(name, barcode, stockBadge);',
"                const priceBlock = document.createElement('span'); priceBlock.className = 'anas-pos-product-price';",
"                const price = document.createElement('strong'); price.textContent = money(pr);",
"                const action = document.createElement('small'); action.textContent = 'اختيار السعر ›';",
'                priceBlock.append(price, action); card.append(info, priceBlock);',
"                card.title = String(p.name ?? '') + ' — ' + money(pr);",
'                card.addEventListener(\'click\', () => openPosPriceTierPicker(p.id));',
'                return card;',
'            };',
'            const deep = window.ANASMicroPOSDeepCore;',
'            if (deep?.ProgressiveListRenderer) {',
"                if (!window.__anasPosProgressiveRenderer || window.__anasPosProgressiveRenderer.containerEl !== cont) {",
'                    window.__anasPosProgressiveRenderer?.destroy?.();',
'                    window.__anasPosProgressiveRenderer = new deep.ProgressiveListRenderer(cont, document.getElementById(\'posQuickProductsProgress\'), 20);',
'                }',
'                window.__anasPosProgressiveRenderer.setItems(filtered, renderCard);',
'            } else {',
'                cont.replaceChildren(...filtered.slice(0, 20).map(renderCard));',
"                const progress = document.getElementById('posQuickProductsProgress');",
"                if (progress) progress.textContent = filtered.length > 20 ? '+20' : String(filtered.length);",
'            }',
"            const empty = document.getElementById('posQuickProductsEmpty');",
'            if (empty) empty.hidden = filtered.length > 0;',
'        }',
''
].join('\n');

html = html.slice(0, start) + replacement + html.slice(end);
html = html.replace("heading.textContent = 'اختر سعر البيع';", "heading.textContent = 'سعر البيع — ' + String(product.name || 'المنتج') + ' (اختر نوع السعر)';");
html = html.replace("{ tier: 1, label: 'تجزئة / الدفعة', value: product.price1 }", "{ tier: 1, label: 'سعر التجزئة (الدفعة)', value: product.price1 }");

const style = '<style id="anas-pos-reference-ui-v1">\n' +
'  #anasPosProductViewToggle{display:flex;align-items:center;gap:7px;padding:8px 10px;background:var(--mp-card,#fff);border-bottom:1px solid var(--mp-border,#e2e8f0);color:var(--mp-text,#172033);font-size:12px;font-weight:800}\n' +
'  #anasPosProductViewToggle span{margin-inline-end:auto}\n' +
'  #anasPosProductViewToggle button{border:1px solid var(--mp-border,#cbd5e1);border-radius:9px;padding:7px 12px;background:var(--mp-bg,#f8fafc);color:var(--mp-text,#334155);font-weight:800;min-height:36px}\n' +
'  #anasPosProductViewToggle button[aria-pressed="true"]{background:#dbeafe;border-color:#2563eb;color:#1d4ed8}\n' +
'  #quickProductsContainer.anas-pos-products-list{display:flex!important;flex-direction:column!important;gap:7px!important;padding:8px!important}\n' +
'  #quickProductsContainer.anas-pos-products-grid{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(min(100%,165px),1fr))!important;gap:8px!important;padding:8px!important}\n' +
'  #quickProductsContainer .anas-pos-product-card{width:100%;min-width:0;min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--mp-border,#dbe2ea);border-radius:12px;background:var(--mp-card,#fff);color:var(--mp-text,#172033);text-align:start;box-shadow:0 2px 7px #0f172a0a;touch-action:manipulation}\n' +
'  #quickProductsContainer.anas-pos-products-grid .anas-pos-product-card{min-height:125px;align-items:stretch;flex-direction:column}\n' +
'  .anas-pos-product-info{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:4px}\n' +
'  .anas-pos-product-name{font-size:14px;line-height:1.35;font-weight:900;overflow-wrap:anywhere}\n' +
'  .anas-pos-product-barcode{font-size:10px;color:var(--mp-text-muted,#64748b);direction:ltr;unicode-bidi:plaintext}\n' +
'  .anas-pos-stock-badge{display:inline-flex;align-items:center;max-width:100%;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:900;white-space:nowrap}\n' +
'  .anas-pos-stock-badge.is-available{background:#dcfce7;color:#166534}.anas-pos-stock-badge.is-low{background:#fef3c7;color:#92400e}.anas-pos-stock-badge.is-out{background:#fee2e2;color:#b91c1c}\n' +
'  .anas-pos-product-price{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:none;color:#15803d}\n' +
'  .anas-pos-product-price strong{font-size:15px;font-weight:950;white-space:nowrap}.anas-pos-product-price small{font-size:10px;color:#2563eb;font-weight:900}\n' +
'  #anasPosPriceTierModal h3{font-size:18px;font-weight:950;line-height:1.4}\n' +
'  #hasibModal .anas-quick-payment-actions button:nth-child(1){background:#dcfce7!important;border-color:#16a34a!important;color:#166534!important}\n' +
'  #hasibModal .anas-quick-payment-actions button:nth-child(2){background:#eff6ff!important;border-color:#60a5fa!important;color:#1d4ed8!important}\n' +
'  #hasibModal .anas-quick-payment-actions button:nth-child(3){background:#fee2e2!important;border-color:#dc2626!important;color:#b91c1c!important}\n' +
'  @media(max-width:480px){#quickProductsContainer.anas-pos-products-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}#quickProductsContainer .anas-pos-product-card{padding:9px;gap:8px}.anas-pos-product-name{font-size:13px}.anas-pos-product-price strong{font-size:13px}}\n' +
'</style>\n';
const posFunctionOffset = html.indexOf('function setAnasPosProductView(mode)');
const scriptBlocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const matchingScript = scriptBlocks.find(match => match.index <= posFunctionOffset && match.index + match[0].length > posFunctionOffset);
if (!matchingScript) throw new Error('POS_INLINE_SCRIPT_BOUNDARY_NOT_FOUND');
try {
  new vm.Script(matchingScript[2], { filename: 'index.html#pos-inline-script' });
} catch (error) {
  const lines = matchingScript[2].split('\n');
  const lineNumber = Number((error.stack || '').match(/index\.html#pos-inline-script:(\d+)/)?.[1] || 0);
  const excerpt = lineNumber ? lines.slice(Math.max(0, lineNumber - 4), lineNumber + 3).join('\n') : '';
  throw new Error('POS_INLINE_SCRIPT_SYNTAX_ERROR: ' + error.message + '\n' + excerpt + '\n' + error.stack);
}
if (!html.includes('id="anas-pos-reference-ui-v1"')) {
  const headClose = html.indexOf('</head>');
  if (headClose < 0) throw new Error('HTML_HEAD_CLOSE_NOT_FOUND');
  html = html.slice(0, headClose) + style + html.slice(headClose);
}
if (html === fs.readFileSync(file, 'utf8')) throw new Error('POS_REFERENCE_PATCH_DID_NOT_CHANGE_HTML');
if (!html.includes('function setAnasPosProductView(mode)') || !html.includes('id="anasPosProductViewToggle"') ||
    !html.includes('id="anas-pos-reference-ui-v1"') || !html.includes('سعر البيع — ')) {
  throw new Error('POS_REFERENCE_PATCH_POSTCONDITION_FAILED');
}
fs.writeFileSync(file, html, 'utf8');
console.log(JSON.stringify({file,beforeBytes:before,afterBytes:Buffer.byteLength(html,'utf8'),financialEngineChanged:false},null,2));
