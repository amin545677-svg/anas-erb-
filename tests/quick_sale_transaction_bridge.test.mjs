import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../core/pos-quick-sale-transaction-bridge.js', import.meta.url), 'utf8');

function createButton() {
  const listeners = {};
  return {
    onclick: 'legacy destructive inline action',
    removed: false,
    removeAttribute(name) { if (name === 'onclick') { this.onclick = null; this.removed = true; } },
    addEventListener(type, callback) { listeners[type] = callback; },
    click() {
      if (listeners.click) listeners.click({
        preventDefault() {},
        stopPropagation() {}
      });
    }
  };
}

function createHarness() {
  const buttons = [createButton(), createButton(), createButton(), createButton()];
  const row = { querySelectorAll: selector => selector === 'button' ? buttons : [] };
  const box = { querySelectorAll: selector => selector === '.qs-cartrow' ? [row] : [] };
  const calls = [];
  let renderCount = 0;
  const win = {
    AppData: { activePriceTier: 2 },
    document: { getElementById: id => id === 'qsCart' ? box : null },
    renderQuickSaleCart() { renderCount++; },
    addItemToPosCart(...args) { calls.push(['add', ...args]); },
    changePosQty(...args) { calls.push(['qty', ...args]); },
    removePosCartItem(...args) { calls.push(['remove', ...args]); },
    clearPosCart() { calls.push(['clear']); }
  };
  vm.runInNewContext(source, { window: win });
  return { win, buttons, calls, get renderCount() { return renderCount; } };
}

test('quick-sale add delegates to canonical POS validation and durable persistence with active price tier', () => {
  const h = createHarness();
  h.win.quickSaleAdd('P-1');
  assert.deepEqual(h.calls, [['add', 'P-1', 2]]);
  assert.equal(h.renderCount, 1);
});

test('quick-sale quantity changes and clear use canonical rollback-safe POS handlers', () => {
  const h = createHarness();
  h.win.quickSaleChangeQty(3, -1);
  h.win.quickSaleClear();
  assert.deepEqual(h.calls, [['qty', 3, -1], ['clear']]);
  assert.equal(h.renderCount, 2);
});

test('quick-sale cart removes legacy inline splice handlers and delegates row actions safely', () => {
  const h = createHarness();
  h.win.renderQuickSaleCart();
  assert.ok(h.buttons.every(button => button.removed && button.onclick === null));
  h.buttons[0].click();
  h.buttons[1].click();
  h.buttons[3].click();
  assert.deepEqual(h.calls, [['qty', 0, -1], ['qty', 0, 1], ['remove', 0]]);
});
