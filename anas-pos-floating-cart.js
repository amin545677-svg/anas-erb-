(function () {
  'use strict';
  if (window.__ANAS_POS_FLOATING_CART_V1__) return;
  window.__ANAS_POS_FLOATING_CART_V1__ = true;

  function currentCart() {
    try { return typeof posCart !== 'undefined' && Array.isArray(posCart) ? posCart : []; }
    catch (_) { return []; }
  }
  function money(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount.toLocaleString('fr-DZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' د.ج' : '—';
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
    let total = 0;
    cart.forEach(function (item, index) {
      const qty = Number(item && item.qty);
      const price = Number(item && item.price);
      const line = Number.isFinite(qty) && Number.isFinite(price) ? Math.round(qty * price * 100) / 100 : 0;
      total += line;
      const row = document.createElement('div');
      row.className = 'anas-pos-mini-line';
      const info = document.createElement('div');
      info.className = 'anas-pos-mini-info';
      const name = document.createElement('strong');
      name.textContent = String(item && item.name || 'منتج');
      const meta = document.createElement('small');
      meta.textContent = money(price) + ' × ' + String(item && item.qty) + ' ' + String(item && item.unit || '');
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
      list.appendChild(row);
    });
    totalNode.textContent = money(total);
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
      '<button type="button" data-mini-action="discount" disabled title="تطبيق الخصم غير متاح قبل ربطه بقيود الفاتورة والدفتر">تخفيض</button>',
      '<button type="button" data-mini-action="quote">مبدئية</button>',
      '<button type="button" data-mini-action="expand">توسيع</button>',
      '<button type="button" class="anas-pos-mini-checkout" data-mini-action="checkout">✓ تأكيد الدفع</button>',
      '</div>'
    ].join('');
    view.appendChild(host);
    host.addEventListener('click', function (event) {
      const button = event.target.closest('[data-mini-action]');
      if (!button) return;
      const action = button.dataset.miniAction;
      if (action === 'free') {
        if (typeof openAddProductModal === 'function') openAddProductModal();
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