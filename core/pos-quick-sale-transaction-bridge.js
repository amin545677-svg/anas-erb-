(function installAnasQuickSaleTransactionBridge(global) {
  'use strict';
  if (!global || global.__ANAS_QUICK_SALE_TRANSACTION_BRIDGE__) return;
  global.__ANAS_QUICK_SALE_TRANSACTION_BRIDGE__ = true;

  function refreshQuickSaleCart() {
    if (typeof global.renderQuickSaleCart === 'function') global.renderQuickSaleCart();
  }

  const originalRender = global.renderQuickSaleCart;
  if (typeof originalRender === 'function') {
    global.renderQuickSaleCart = function () {
      const result = originalRender.apply(this, arguments);
      const box = global.document && global.document.getElementById('qsCart');
      if (!box) return result;
      box.querySelectorAll('.qs-cartrow').forEach((row, index) => {
        const buttons = row.querySelectorAll('button');
        const bind = (button, action) => {
          if (!button || button.__anasTransactionBound) return;
          button.__anasTransactionBound = true;
          button.removeAttribute('onclick');
          button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            action(index);
            refreshQuickSaleCart();
          });
        };
        // The row's controls are: decrement, increment, and delete (fourth button).
        bind(buttons[0], i => global.changePosQty(i, -1));
        bind(buttons[1], i => global.changePosQty(i, 1));
        bind(buttons[3], i => global.removePosCartItem(i));
      });
      return result;
    };
  }

  // The quick-sale panel must use the same validated, durable transaction path as POS.
  global.quickSaleAdd = function (productId) {
    if (typeof global.addItemToPosCart !== 'function') {
      throw new Error('ANAS_POS_TRANSACTION_API_UNAVAILABLE');
    }
    const tier = Number(global.AppData && global.AppData.activePriceTier) || 1;
    global.addItemToPosCart(productId, tier);
    refreshQuickSaleCart();
  };

  global.quickSaleChangeQty = function (index, delta) {
    if (typeof global.changePosQty !== 'function') {
      throw new Error('ANAS_POS_QUANTITY_API_UNAVAILABLE');
    }
    global.changePosQty(index, delta);
    refreshQuickSaleCart();
  };

  global.quickSaleClear = function () {
    if (typeof global.clearPosCart !== 'function') {
      throw new Error('ANAS_POS_CLEAR_API_UNAVAILABLE');
    }
    global.clearPosCart();
    refreshQuickSaleCart();
  };
})(window);
