import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPosPresentationController,
  normalizePosSearchText,
  searchPosProducts
} from '../pos/pos-presentation-engine.mjs';

test('Arabic normalization makes hamza, diacritics and tatweel searchable', () => {
  assert.equal(normalizePosSearchText('إِبْرَاهِيمـ'), 'ابراهيم');
});

test('barcode exact match outranks product-name substring and keeps stable tie order', () => {
  const rows = [
    { id: 'name', name: 'منتج 123', barcode: '900' },
    { id: 'prefix', name: 'قلم', barcode: '12345' },
    { id: 'exact', name: 'دفتر', barcode: '123' },
    { id: 'second', name: 'ممحاة', barcode: '123' }
  ];
  assert.deepEqual(searchPosProducts(rows, '123').map(row => row.id), ['exact', 'second', 'prefix', 'name']);
});

test('multi-token search matches across normalized Arabic product fields', () => {
  const rows = [
    { id: 'a', name: 'قهوة ممتازة' },
    { id: 'b', name: 'قهوة' },
    { id: 'c', barcode: 'قهوة-ممتازة' }
  ];
  assert.deepEqual(searchPosProducts(rows, 'ممتازة قهوة').map(row => row.id), ['a', 'c']);
});

test('switching list/grid preserves the exact cart and invoice draft references', () => {
  const cart = [{ id: 'p1', quantity: 2 }];
  const invoiceDraft = { customerId: 'c1', note: 'draft' };
  const controller = createPosPresentationController({ cart, invoiceDraft, mode: 'list' });
  const after = controller.setMode('grid');
  assert.equal(after.mode, 'grid');
  assert.equal(after.cart, cart);
  assert.equal(after.invoiceDraft, invoiceDraft);
  assert.equal(after.cartLineCount, 1);
  assert.equal(controller.toggleMode().mode, 'list');
  assert.equal(controller.snapshot().cart, cart);
});

test('filters and search compose without mutating source products or cart', () => {
  const products = [
    { id: 'available', name: 'قهوة عربية', barcode: '100', stock: 20, minAlert: 5 },
    { id: 'low', name: 'قهوة خفيفة', barcode: '101', stock: 2, minAlert: 5 },
    { id: 'out', name: 'شاي', barcode: '102', stock: 0, minAlert: 5 }
  ];
  const cart = [{ id: 'kept', quantity: 1 }];
  const controller = createPosPresentationController({ products, cart });
  const result = controller.setStockFilter('available');
  assert.deepEqual(result.visibleProducts.map(row => row.id), ['available']);
  assert.deepEqual(controller.setQuery('قهوة').visibleProducts.map(row => row.id), ['available']);
  assert.equal(controller.snapshot().cart, cart);
  assert.equal(products.length, 3);
});

test('invalid presentation mode and stock filters fail closed', () => {
  const controller = createPosPresentationController();
  assert.throws(() => controller.setMode('tiles'), /INVALID_POS_VIEW_MODE/);
  assert.throws(() => controller.setStockFilter('negative'), /INVALID_POS_STOCK_FILTER/);
});
