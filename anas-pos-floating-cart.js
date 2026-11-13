(function () {
  'use strict';
  if (window.__ANAS_POS_FLOATING_CART_V1__) return;
  window.__ANAS_POS_FLOATING_CART_V1__ = true;

  function currentCart() {
    try { return typeof posCart !== 'undefined' && Array.isArray(posCart) ? posCart : []; }
    catch (_) { return []; }
  }
  function decimalScaled(value, digits) {
    const match = /^([+-]?)(\\d+)(?:[.,](\\d*))?$/.exec(String(value == null ? '0' : value).trim());
    if (!match) return null;
    const fraction = match[3] || '';
    const kept = fraction.slice(0, digits).padEnd(digits, '0');
    let scaled = BigInt(match[2]) * (10n ** BigInt(digits)) + BigInt(kept || '0');
    if (fraction.length > digits && fraction.charCodeAt(digits) >= 53) scaled += 1n;
    return match[1] === '-' ? -scaled : scaled;
  }
  function moneyFromCents(cents) {
    if (typeof cents !== 'bigint') return '—';
    const negative = cents < 0n, absolute = negative ? -cents : cents;
    return (negative ? '−' : '') + (absolute / 100n).toLocaleString('fr-DZ') + ',' +
      String(absolute % 100n).padStart(2, '0') + ' د.ج';
  }
  function money(value) {
    const cents = decimalScaled(value, 2);
    return cents === null ? '—' : moneyFromCents(cents);
  }
  function stepFor(item) {
    const unit = String(item && item.unit || '').trim().toLocaleLowerCase();
    return ['kg','kilogram','kilograms','كغ','كجم','كيلوغرام','كيلو'].includes(unit) ? 0.1 : 1;
  }
  function render() {
    const host = document.getElementById('anasPosFloatingCart');
    const view = document.getElementById('view-pos');
    if (!host || !view) return;
    const cart = currentCart();
    const active = view.classList.contains('active');
    host.hidden = !active || cart.length === 0;
    if (host.hidden) return;
    const list = host.querySelector('[data-mini-cart-lines]');
    const totalNode = host.querySelector('[data-mini-cart-total]');
    const countNode = host.querySelector('[data-mini-cart-count]');
    list.replaceChildren();
    let totalCentsFallback = 0n;
    cart.forEach(function (item, index) {
      const qtyMicros = decimalScaled(item && item.qty, 6);
      const priceCents = decimalScaled(item && item.price, 2);
      if (qtyMicros === null || priceCents === null) totalCentsFallback = null;
      else if (totalCentsFallback !== null) {
        const product = qtyMicros * priceCents;
        totalCentsFallback += product >= 0n ? (product + 500000n) / 1000000n : (product - 500000n) / 1000000n;
      }
      const row = document.createElement('div');
      row.className = 'anas-pos-mini-line';
      const info = document.createElement('div');
      info.className = 'anas-pos-mini-info';
      const name = document.createElement('strong');
      name.textContent = String(item && item.name || 'منتج');
      const meta = document.createElement('small');
      meta.textContent = moneyFromCents(priceCents) + ' × ' + String(item && item.qty) + ' ' + String(item && item.unit || '');
      info.append(name, meta);
      const controls = document.createElement('div');
      controls.className = 'anas-pos-mini-qty';
      const minus = document.createElement('button');
      minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'إنقاص ' + String(item && item.name || 'الكمية'));
      minus.addEventListener('click', function () {
        const next = Number(item.qty) - stepFor(item);
        if (next <= 0) {
          if (typeof removePosCartItem === 'function') removePosCartItem(index);
        } else if (typeof setPosQty === 'function') setPosQty(index, String(Number(next.toFixed(6))));
        render();
      });
      const quantity = document.createElement('span');
      quantity.textContent = String(item && item.qty);
      const plus = document.createElement('button');
      plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'زيادة ' + String(item && item.name || 'الكمية'));
      plus.addEventListener('click', function () {
        const next = Number(item.qty) + stepFor(item);
        if (typeof setPosQty === 'function') setPosQty(index, String(Number(next.toFixed(6))));
        render();
      });
      controls.append(minus, quantity, plus);
      row.append(info, controls);
      if (['kg','kilogram','kilograms','كغ','كجم','كيلوغرام','كيلو'].includes(String(item && item.unit || '').trim().toLocaleLowerCase())) {
        const quick = document.createElement('div');
        quick.className = 'anas-pos-quick-weights';
        quick.setAttribute('role', 'group');
        quick.setAttribute('aria-label', 'أوزان سريعة');
        ['0.25', '0.5', '1', '2', '5', '10'].forEach(function (weight) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'anas-weight-chip' + (decimalScaled(item.qty, 2) === decimalScaled(weight, 2) ? ' is-active' : '');
          chip.textContent = String(weight);
          chip.dataset.action = 'set-quick-weight';
          chip.dataset.cartIndex = String(index);
          chip.dataset.weight = String(weight);
          chip.setAttribute('aria-label', 'تعيين الوزن ' + String(weight) + ' كيلوغرام');
          quick.appendChild(chip);
        });
        row.appendChild(quick);
      }
      list.appendChild(row);
    });
    let netCents = totalCentsFallback;
    if (typeof anasCartTotalCents === 'function') {
      const calculated = anasCartTotalCents(cart);
      if (typeof calculated === 'bigint') netCents = calculated;
      else if (Number.isSafeInteger(calculated)) netCents = BigInt(calculated);
      else netCents = null;
    }
    totalNode.textContent = typeof netCents === 'bigint' ? moneyFromCents(netCents) : '—';
    countNode.textContent = String(cart.length);
  }
  function mount() {
    const view = document.getElementById('view-pos');
    if (!view || document.getElementById('anasPosFloatingCart')) return !!view;
    const host = document.createElement('aside');
    host.id = 'anasPosFloatingCart';
    host.className = 'anas-pos-floating-cart';
    host.hidden = true;
    host.setAttribute('aria-label', 'السلة العائمة');
    host.innerHTML = [
      '<div class="anas-pos-mini-head"><strong>🛒 السلة <span data-mini-cart-count>0</span></strong><strong data-mini-cart-total>0.00 د.ج</strong></div>',
      '<div class="anas-pos-mini-lines" data-mini-cart-lines></div>',
      '<div class="anas-pos-mini-actions">',
      '<button type="button" data-mini-action="free">إضافة منتج</button>',
      '<button type="button" data-mini-action="discount">تخفيض</button>',
      '<button type="button" data-mini-action="quote">مبدئية</button>',
      '<button type="button" data-mini-action="expand">توسيع</button>',
      '<button type="button" class="anas-pos-mini-checkout" data-mini-action="checkout">✓ تأكيد الدفع</button>',
      '</div>'
    ].join('');
    view.appendChild(host);
    host.addEventListener('click', function (event) {
      const weightChip = event.target.closest('[data-action="set-quick-weight"]');
      if (weightChip) {
        const index = Number(weightChip.dataset.cartIndex);
        const weight = String(weightChip.dataset.weight || '');
        const cart = currentCart();
        if (Number.isInteger(index) && index >= 0 && index < cart.length &&
            decimalScaled(weight, 2) !== null && decimalScaled(weight, 2) > 0n && typeof setPosQty === 'function') {
          setPosQty(index, weight);
          if (typeof window.renderPosTable === 'function') window.renderPosTable();
          render();
        }
        return;
      }
      const button = event.target.closest('[data-mini-action]');
      if (!button) return;
      const action = button.dataset.miniAction;
      if (action === 'free') {
        const name = prompt('اسم المنتج الحر (لا يُضاف إلى جدول المخزون):');
        if (name === null || !name.trim()) return;
        const price = prompt('سعر الوحدة بالدينار:', '0');
        if (price === null) return;
        const quantity = prompt('الكمية:', '1');
        if (quantity === null) return;
        const unit = prompt('الوحدة:', 'قطعة') || 'قطعة';
        if (typeof anasAddFreeCartItem !== 'function') {
          alert('محرك المنتج الحر غير متاح؛ لم تتم إضافة أي بيانات.');
          return;
        }
        anasAddFreeCartItem(name, price, quantity, unit);
      } else if (action === 'discount') {
        const current = typeof anasGetPosCartDiscountCents === 'function' ? anasGetPosCartDiscountCents() : 0;
        const value = prompt('قيمة التخفيض الإجمالي بالدينار:', Number.isSafeInteger(current) ? (current / 100).toFixed(2) : '0.00');
        if (value === null) return;
        if (typeof setPosCartDiscount !== 'function') {
          alert('محرك التخفيض غير متاح؛ لم يتم تعديل الفاتورة.');
          return;
        }
        setPosCartDiscount(value);
      } else if (action === 'quote') {
        if (typeof switchPosScreen === 'function') switchPosScreen('quote');
      } else if (action === 'expand') {
        document.getElementById('posItemsTableBody')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (action === 'checkout') {
        if (typeof openHasibModal === 'function') openHasibModal();
      }
    });
    return true;
  }

  function hookRender() {
    if (typeof window.renderPosTable === 'function' && !window.renderPosTable.__anasMiniCartWrapped) {
      const original = window.renderPosTable;
      const wrapped = function () {
        const result = original.apply(this, arguments);
        render();
        return result;
      };
      wrapped.__anasMiniCartWrapped = true;
      window.renderPosTable = wrapped;
    }
  }
  function start() {
    if (!mount()) return false;
    hookRender();
    render();
    const body = document.getElementById('posItemsTableBody');
    if (body && !body.__anasMiniCartObserver) {
      const observer = new MutationObserver(render);
      observer.observe(body, { childList: true, subtree: true, characterData: true });
      body.__anasMiniCartObserver = observer;
    }
    const view = document.getElementById('view-pos');
    if (view && !view.__anasMiniCartViewObserver) {
      const viewObserver = new MutationObserver(render);
      viewObserver.observe(view, { attributes: true, attributeFilter: ['class'] });
      view.__anasMiniCartViewObserver = viewObserver;
    }
    document.addEventListener('click', function (event) {
      if (event.target.closest('#posCheckoutBtn,[onclick*="addItemToPosCart"],#quickProductsContainer button')) {
        setTimeout(function () { hookRender(); render(); }, 0);
      }
    }, true);
    document.addEventListener('anas:pos-cart-updated', render);
    return true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  const observer = new MutationObserver(function () {
    if (start()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();