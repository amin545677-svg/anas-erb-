import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePendingMutations, comparePendingMutationsDeterministically } from "../sync/mutation_reconciliation.mjs";

function cloud() {
  return {
    caisseBalance: 54000,
    customers: [{ id: "cust_s", debt: 26000 }],
    products: [{ id: "item_a", stock: 90 }],
    invoices: [{ id: "cloud-invoice" }],
    stockMovements: [{ id: "cloud-stock-movement" }],
    cashMovements: [{ id: "cloud-cash" }],
    appliedOpIds: []
  };
}
function collection(opId = "op-deviceB-collection-5000") {
  return {
    opId, type: "DEBT_COLLECTION", baseCloudRevision: "V0",
    createdAt: "2026-10-28T14:00:00.000Z",
    payload: { customerId: "cust_s", amount: 5000, cashMovementId: "cm_991" }
  };
}

test("replays an unacknowledged debt collection over cloud V1 without changing the source snapshot", () => {
  const original = cloud();
  const result = reconcilePendingMutations(original, [collection()]);
  assert.equal(result.snapshot.products[0].stock, 90);
  assert.equal(result.snapshot.caisseBalance, 59000);
  assert.equal(result.snapshot.customers[0].debt, 21000);
  assert.ok(result.snapshot.cashMovements.some(m => m.id === "cm_991" && m.amount === 5000));
  assert.ok(result.snapshot.appliedOpIds.includes("op-deviceB-collection-5000"));
  assert.deepEqual(original, cloud(), "reconciliation must not mutate the supplied cloud snapshot");
  assert.deepEqual(result.review, []);
});

test("replaying the same operation ID is idempotent", () => {
  const once = reconcilePendingMutations(cloud(), [collection()]);
  const twice = reconcilePendingMutations(once.snapshot, [collection()]);
  assert.equal(twice.snapshot.caisseBalance, 59000);
  assert.equal(twice.snapshot.customers[0].debt, 21000);
  assert.equal(twice.snapshot.cashMovements.filter(m => m.id === "cm_991").length, 1);
  assert.deepEqual(twice.appliedNow, [{ opId: "op-deviceB-collection-5000", outcome: "folded-duplicate" }]);
  assert.equal(twice.snapshot.appliedOperations.length, 1);
  assert.match(twice.snapshot.appliedOperations[0].payloadHash, /^[a-f0-9]{64}$/);
  assert.match(twice.snapshot.appliedOperations[0].parentStateHash, /^[a-f0-9]{64}$/);
});

test("quarantines a sale when cloud stock is insufficient but still replays a safe collection", () => {
  const sale = {
    opId: "op-deviceB-sale-10", type: "SALE_INVOICE",
    payload: {
      productId: "item_a", quantity: 10,
      invoice: { id: "local-invoice-10", total: 10000 },
      stockMovement: { id: "local-stock-10", quantity: -10 }
    }
  };
  const result = reconcilePendingMutations(cloud(), [
    { ...sale, payload: { ...sale.payload, quantity: 95 } },
    collection()
  ]);
  assert.equal(result.snapshot.products[0].stock, 90);
  assert.equal(result.snapshot.caisseBalance, 59000);
  assert.equal(result.snapshot.customers[0].debt, 21000);
  assert.ok(result.review.some(item => item.opId === sale.opId && item.reason === "INSUFFICIENT_CLOUD_STOCK"));
  assert.ok(result.snapshot.appliedOpIds.includes(collection().opId));
});

test("quarantines unsafe collections instead of creating negative customer debt", () => {
  const op = { ...collection(), payload: { ...collection().payload, amount: 30000 } };
  const result = reconcilePendingMutations(cloud(), [op]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "COLLECTION_EXCEEDS_RECORDED_DEBT_OR_INVALID_DEBT");
});

test("unknown operation types remain in review and are not silently discarded", () => {
  const result = reconcilePendingMutations(cloud(), [{ opId: "op-future", type: "TRUCK_SETTLEMENT", payload: {} }]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.review[0].reason, "UNSUPPORTED_OPERATION_TYPE");
});

function saleOp({ opId, warehouse = "المخزن الرئيسي", total = 1000, paid = total, quantity = 2, customerId = null }) {
  const remaining = Math.round((total - paid + Number.EPSILON) * 100) / 100;
  return {
    opId,
    type: "SALE_INVOICE",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      ...(customerId ? { customerId } : {}),
      invoice: {
        id: `inv-${opId}`,
        date: "2026-10-28",
        customer: customerId ? "عميل آجل" : "عميل نقدي عابر",
        items: [{ id: "item_a", name: "صنف اختبار", qty: quantity, price: total / quantity }],
        total, paid, remaining, warehouse, warehouseName: warehouse,
        paymentMethod: paid <= 0 ? "credit" : (remaining > 0 ? "partial" : "cash")
      }
    }
  };
}

test("V42 parity: full cash sale reduces main stock and increases cash without synthetic movements", () => {
  const initial = cloud();
  const op = saleOp({ opId: "sale-cash", total: 1000, paid: 1000 });
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 88);
  assert.equal(result.snapshot.caisseBalance, 55000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.snapshot.invoices[0].id, "inv-sale-cash");
  assert.equal(result.snapshot.cashMovements.length, initial.cashMovements.length);
  assert.equal(result.snapshot.stockMovements.length, initial.stockMovements.length);
});

test("V42 parity: full credit sale keeps cash fixed and increases registered customer debt", () => {
  const initial = cloud();
  initial.customers[0].name = "عميل آجل";
  const op = saleOp({ opId: "sale-credit", total: 1000, paid: 0, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 88);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 27000);
  assert.equal(result.snapshot.invoices[0].paymentMethod, "credit");
  assert.equal(result.snapshot.cashMovements.length, initial.cashMovements.length);
  assert.equal(result.snapshot.stockMovements.length, initial.stockMovements.length);
});

test("V42 parity: mixed sale from a secondary warehouse updates only that warehouse, cash paid and debt remaining", () => {
  const initial = cloud();
  initial.products[0].warehouseStock = { "شاحنة 1": 15 };
  initial.customers[0].name = "عميل مختلط";
  const op = saleOp({ opId: "sale-mixed", warehouse: "شاحنة 1", total: 1000, paid: 400, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 90);
  assert.equal(result.snapshot.products[0].warehouseStock["شاحنة 1"], 13);
  assert.equal(result.snapshot.caisseBalance, 54400);
  assert.equal(result.snapshot.customers[0].debt, 26600);
  assert.equal(result.snapshot.invoices[0].paymentMethod, "partial");
  assert.equal(result.snapshot.cashMovements.length, initial.cashMovements.length);
  assert.equal(result.snapshot.stockMovements.length, initial.stockMovements.length);
});

test("rejects fractional-cent collection amounts instead of silently rounding them", () => {
  const op = { ...collection(), payload: { ...collection().payload, amount: 500.555 } };
  const result = reconcilePendingMutations(cloud(), [op]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "INVALID_AMOUNT");
});

test("quarantines a cash movement ID collision when the existing amount differs", () => {
  const initial = cloud();
  initial.cashMovements.push({ id: "cm_991", amount: 4000, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [collection()]);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "CASH_MOVEMENT_ID_COLLISION");
  assert.deepEqual(result.appliedNow, []);
});

test("quarantines collection when adding its cents would overflow the safe integer range", () => {
  const initial = cloud();
  initial.caisseBalance = Number.MAX_SAFE_INTEGER / 100;
  const result = reconcilePendingMutations(initial, [collection()]);
  assert.equal(result.snapshot.caisseBalance, initial.caisseBalance);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.equal(result.review[0].reason, "CASH_BALANCE_OVERFLOW");
});

test("quarantines credit sales when customer debt would overflow safe integer cents", () => {
  const initial = cloud();
  initial.customers[0].debt = Number.MAX_SAFE_INTEGER / 100;
  const op = saleOp({ opId: "sale-debt-overflow", total: 1, paid: 0, customerId: "cust_s", quantity: 1 });
  const result = reconcilePendingMutations(initial, [op]);
  assert.equal(result.snapshot.customers[0].debt, initial.customers[0].debt);
  assert.equal(result.review[0].reason, "INVALID_CUSTOMER_DEBT");
});


test("existing invoice is skipped only when its operation marker and full payload match", () => {
  const op = saleOp({ opId: "invoice-marker-verified", total: 1000, paid: 1000 });
  const initial = cloud();
  const existing = structuredClone(op.payload.invoice);
  existing.syncOpId = op.opId;
  existing.syncCreatedAt = "2026-10-28T12:00:00.000Z";
  initial.invoices.unshift(existing);

  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.deepEqual(result.appliedNow, [{
    opId: op.opId,
    outcome: "already-applied",
    reason: "VERIFIED_INVOICE_AND_LEDGER_BUNDLE"
  }]);
  assert.equal(result.snapshot.products[0].stock, 90, "verified duplicate must not deduct stock twice");
  assert.equal(result.snapshot.caisseBalance, 54000, "verified duplicate must not add cash twice");
  assert.equal(result.snapshot.invoices.filter(item => item.id === op.payload.invoice.id).length, 1);
});

test("invoice ID collisions without the exact operation marker or with changed payload are quarantined", () => {
  const cases = [
    {
      label: "legacy/unmarked invoice",
      mutate: invoice => { delete invoice.syncOpId; }
    },
    {
      label: "invoice marked by another operation",
      mutate: invoice => { invoice.syncOpId = "different-operation"; }
    },
    {
      label: "same marker but changed financial payload",
      mutate: invoice => { invoice.syncOpId = "invoice-collision-guard"; invoice.total = 999; }
    }
  ];

  for (const scenario of cases) {
    const op = saleOp({ opId: "invoice-collision-guard", total: 1000, paid: 1000 });
    const initial = cloud();
    const existing = structuredClone(op.payload.invoice);
    existing.syncOpId = op.opId;
    scenario.mutate(existing);
    initial.invoices.unshift(existing);

    const result = reconcilePendingMutations(initial, [op]);
    assert.equal(result.review.length, 1, scenario.label);
    assert.equal(result.review[0].reason, "INVOICE_ID_COLLISION", scenario.label);
    assert.deepEqual(result.appliedNow, [], scenario.label);
    assert.equal(result.snapshot.products[0].stock, 90, scenario.label + ": stock must remain unchanged");
    assert.equal(result.snapshot.caisseBalance, 54000, scenario.label + ": cash must remain unchanged");
    assert.equal(result.snapshot.invoices[0].total, existing.total, scenario.label + ": existing audit data must remain unchanged");
  }
});


test("does not accept an unmarked cash movement as proof of an already-applied collection", () => {
  const initial = cloud();
  initial.cashMovements.push({ id: "cm_991", amount: 5000, customerId: "cust_s" });
  const result = reconcilePendingMutations(initial, [collection()]);
  assert.equal(result.review[0].reason, "CASH_MOVEMENT_ID_COLLISION");
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
});

test("quarantines appliedOpIds markers when their durable business entity is missing", () => {
  const collectionSnapshot = cloud();
  collectionSnapshot.appliedOpIds = [collection().opId];
  const collectionResult = reconcilePendingMutations(collectionSnapshot, [collection()]);
  assert.equal(collectionResult.review[0].reason, "APPLIED_OPERATION_ENTITY_MISSING");
  assert.equal(collectionResult.snapshot.caisseBalance, 54000);
  assert.equal(collectionResult.snapshot.customers[0].debt, 26000);

  const sale = saleOp({ opId: "sale-marker-without-invoice", total: 1000, paid: 1000 });
  const saleSnapshot = cloud();
  saleSnapshot.appliedOpIds = [sale.opId];
  const saleResult = reconcilePendingMutations(saleSnapshot, [sale]);
  assert.equal(saleResult.review[0].reason, "APPLIED_OPERATION_ENTITY_MISSING");
  assert.equal(saleResult.snapshot.products[0].stock, 90);
  assert.equal(saleResult.snapshot.caisseBalance, 54000);
  assert.equal(saleResult.snapshot.invoices.some(item => item.id === sale.payload.invoice.id), false);
});


test("same opId with a changed canonical payload is a hard idempotency mismatch", () => {
  const original = collection("K_LOST_ACK");
  const once = reconcilePendingMutations(cloud(), [original]);
  const changed = { ...original, payload: { ...original.payload, amount: 5001 } };
  assert.throws(() => reconcilePendingMutations(once.snapshot, [changed]),
    error => error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH");
});

test("applied operation records are bound to the canonical payload and causal parent", () => {
  const original = cloud();
  const result = reconcilePendingMutations(original, [collection("K_CAUSAL")]);
  const record = result.snapshot.appliedOperations.find(item => item.opId === "K_CAUSAL");
  assert.ok(record);
  assert.equal(record.payloadHash.length, 64);
  assert.equal(record.parentStateHash.length, 64);
  assert.equal(original.appliedOperations, undefined, "source snapshot remains unchanged");
});


test("money replay parses exact decimal centimes without binary-float scaling", () => {
  const initial = cloud();
  const op = { ...collection("exact-decimal-0-10"), payload: {
    ...collection().payload, amount: "0.10"
  }};
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.caisseBalance, 54000.1);
  assert.equal(result.snapshot.customers[0].debt, 25999.9);
});

test("money replay quarantines fractional-cent, exponent and unsafe-range inputs", () => {
  for (const [index, amount] of ["1.001", "1e2", "90071992547409.92", -0].entries()) {
    const op = { ...collection("invalid-exact-money-" + index), payload: {
      ...collection().payload, amount
    }};
    const result = reconcilePendingMutations(cloud(), [op]);
    assert.equal(result.snapshot.caisseBalance, 54000, String(amount));
    assert.equal(result.snapshot.customers[0].debt, 26000, String(amount));
    assert.equal(
      result.review[0].reason,
      Object.is(amount, -0) ? "NON_CANONICAL_NUMERIC_VALUE" : "INVALID_AMOUNT",
      String(amount)
    );
  }
});


test("Level 24-D orders by BigInt localSeq then NFC-normalized UTF-16 opId", () => {
  const queue = [
    { localSeq: "12", opId: "z" },
    { localSeq: 2, opId: "b" },
    { localSeq: "2", opId: "a" },
    { opId: "e\u0301" },
    { opId: "z" },
    { localSeq: 1, opId: "late" }
  ];
  const sorted = queue.slice().sort(comparePendingMutationsDeterministically);
  assert.deepEqual(sorted.map(x => x.opId), ["late", "a", "b", "z", "z", "e" + String.fromCharCode(0x0301)]);
  assert.equal(comparePendingMutationsDeterministically(
    { localSeq: "9007199254740993", opId: "a" },
    { localSeq: "9007199254740992", opId: "z" }
  ), 1);
});


test("derives omitted sale remaining balance using exact integer centimes", () => {
  const initial = cloud();
  initial.customers[0].name = "عميل دقيق";
  const op = saleOp({
    opId: "sale-centime-derived",
    total: 0.3,
    paid: 0.1,
    customerId: "cust_s"
  });
  delete op.payload.invoice.remaining;
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 88);
  assert.equal(result.snapshot.caisseBalance, 54000.1);
  assert.equal(result.snapshot.customers[0].debt, 26000.2);
  assert.equal(result.snapshot.invoices[0].total, 0.3);
});


test("V42 sale reconciliation commits cash, stock, customer and allocation ledgers as one exact bundle", () => {
  const initial = cloud();
  initial.customers[0].debt = 25000;
  const invoice = {
    id: "inv-v42-bundle", customerId: "cust_s", total: 1000, paid: 400, remaining: 600,
    paymentMethod: "partial", paymentChannel: "cash", warehouse: "المخزن الرئيسي",
    items: [{ id: "item_a", qty: 2, price: 500 }]
  };
  const op = {
    opId: "sale-v42-bundle", type: "SALE_INVOICE",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      customerId: "cust_s", warehouse: "المخزن الرئيسي", invoice,
      v42Ledger: {
        cashMovements: [{
          id: "SALE-CASH-inv-v42-bundle", type: "add", amount: 400,
          paymentChannel: "cash", cashImpact: true,
          referenceType: "sales_invoice", referenceId: invoice.id
        }],
        bankMovements: [],
        stockMovements: [{
          id: "SALE-STOCK-inv-v42-bundle-item_a", productId: "item_a",
          qty: -2, type: "SALE_OUT", referenceType: "sales_invoice",
          referenceId: invoice.id, warehouse: "المخزن الرئيسي"
        }],
        clientMovements: [{
          movementId: "CL-OPEN-cust_s-v42-sale", clientId: "cust_s",
          type: "opening_balance", amountCentimes: 2600000, direction: "debit",
          referenceType: "opening_balance", referenceId: "cust_s",
          createdAt: "2026-10-28T12:00:00.000Z"
        }, {
          movementId: "CL-INV-inv-v42-bundle", clientId: "cust_s",
          type: "invoice_debit", amountCentimes: 60000, direction: "debit",
          referenceType: "sales_invoice", referenceId: invoice.id,
          createdAt: "2026-10-28T12:00:00.000Z"
        }],
        settlementAllocations: [{
          allocationId: "ALLOC-SALE-inv-v42-bundle", partyType: "customer",
          partyId: "cust_s", invoiceType: "sales_invoice", invoiceId: invoice.id,
          sourceMovementId: "SALE-CASH-inv-v42-bundle",
          sourceMovementType: "sales_invoice", amountCentimes: 40000,
          createdAt: "2026-10-28T12:00:00.000Z"
        }]
      }
    }
  };
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.products[0].stock, 88);
  assert.equal(result.snapshot.caisseBalance, 54400);
  assert.equal(result.snapshot.customers[0].debt, 25600);
  assert.equal(result.snapshot.invoices[0].id, invoice.id);
  assert.equal(result.snapshot.cashMovements.filter(row => row.id === "SALE-CASH-inv-v42-bundle").length, 1);
  assert.equal(result.snapshot.stockMovements.filter(row => row.id === "SALE-STOCK-inv-v42-bundle-item_a").length, 1);
  assert.equal(result.snapshot.clientMovements.filter(row => row.movementId === "CL-INV-inv-v42-bundle").length, 1);
  assert.equal(result.snapshot.clientMovements.find(row => row.type === "opening_balance").amountCentimes, 2500000,
    "sale opening balance must be rebased to authoritative cloud debt");
  assert.equal(result.snapshot.settlementAllocations.filter(row => row.allocationId === "ALLOC-SALE-inv-v42-bundle").length, 1);
  const replay = reconcilePendingMutations(result.snapshot, [op]);
  assert.deepEqual(replay.review, []);
  assert.equal(replay.snapshot.cashMovements.filter(row => row.id === "SALE-CASH-inv-v42-bundle").length, 1);
  assert.equal(replay.snapshot.stockMovements.filter(row => row.id === "SALE-STOCK-inv-v42-bundle-item_a").length, 1);
});

test("V42 non-cash sale records bank settlement without increasing physical cashbox", () => {
  const initial = cloud();
  const invoice = {
    id: "inv-v42-bank", customerId: "cust_s", total: 1000, paid: 1000, remaining: 0,
    paymentMethod: "cash", paymentChannel: "transfer", warehouse: "المخزن الرئيسي",
    items: [{ id: "item_a", qty: 1, price: 1000 }]
  };
  const op = {
    opId: "sale-v42-bank", type: "SALE_INVOICE",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      customerId: "cust_s", invoice,
      v42Ledger: {
        cashMovements: [],
        bankMovements: [{
          id: "SALE-BANK-inv-v42-bank", type: "add", amount: 1000,
          paymentChannel: "transfer", cashImpact: false,
          referenceType: "sales_invoice", referenceId: invoice.id
        }],
        stockMovements: [{
          id: "SALE-STOCK-inv-v42-bank-item_a", productId: "item_a",
          qty: -1, type: "SALE_OUT", referenceType: "sales_invoice",
          referenceId: invoice.id, warehouse: "المخزن الرئيسي"
        }],
        clientMovements: [{
          movementId: "CL-OPEN-cust_s-v42-bank", clientId: "cust_s",
          type: "opening_balance", amountCentimes: 2600000, direction: "debit",
          referenceType: "opening_balance", referenceId: "cust_s",
          createdAt: "2026-10-28T12:00:00.000Z"
        }],
        settlementAllocations: [{
          allocationId: "ALLOC-SALE-inv-v42-bank", partyType: "customer",
          partyId: "cust_s", invoiceType: "sales_invoice", invoiceId: invoice.id,
          sourceMovementId: "SALE-BANK-inv-v42-bank",
          sourceMovementType: "sales_invoice", amountCentimes: 100000,
          createdAt: "2026-10-28T12:00:00.000Z"
        }]
      }
    }
  };
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.products[0].stock, 89);
  assert.equal(result.snapshot.bankMovements.length, 1);
  assert.equal(result.snapshot.bankMovements[0].amount, 1000);
  assert.equal(result.snapshot.settlementAllocations[0].amountCentimes, 100000);
});

test("V42 sale with a missing cash ledger row is quarantined without changing any financial entity", () => {
  const initial = cloud();
  const invoice = {
    id: "inv-v42-missing-ledger", customerId: "cust_s", total: 1000, paid: 1000, remaining: 0,
    paymentChannel: "cash", warehouse: "المخزن الرئيسي",
    items: [{ id: "item_a", qty: 1, price: 1000 }]
  };
  const op = {
    opId: "sale-v42-missing-ledger", type: "SALE_INVOICE",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      customerId: "cust_s", invoice,
      v42Ledger: {
        cashMovements: [], bankMovements: [],
        stockMovements: [{
          id: "SALE-STOCK-inv-v42-missing-ledger-item_a", productId: "item_a",
          qty: -1, type: "SALE_OUT", referenceType: "sales_invoice",
          referenceId: invoice.id, warehouse: "المخزن الرئيسي"
        }],
        clientMovements: [],
        settlementAllocations: [{
          allocationId: "ALLOC-SALE-inv-v42-missing-ledger", partyType: "customer",
          partyId: "cust_s", invoiceType: "sales_invoice", invoiceId: invoice.id,
          sourceMovementId: "missing-cash-movement", sourceMovementType: "sales_invoice",
          amountCentimes: 100000, createdAt: "2026-10-28T12:00:00.000Z"
        }]
      }
    }
  };
  const result = reconcilePendingMutations(initial, [op]);
  assert.equal(result.review[0]?.reason, "SALE_PAYMENT_LEDGER_MISMATCH");
  assert.equal(result.snapshot.products[0].stock, 90);
  assert.equal(result.snapshot.caisseBalance, 54000);
  assert.equal(result.snapshot.customers[0].debt, 26000);
  assert.deepEqual(result.snapshot.invoices, initial.invoices);
});


test("V42 debt collection reconciliation preserves receipt, opening balance and FIFO allocation ledgers", () => {
  const initial = cloud();
  initial.customers[0].debt = 19500;
  initial.invoices = [{
    id: "inv-collection-v42", customerId: "cust_s",
    total: 26000, paid: 0, remaining: 26000
  }];
  const op = {
    opId: "collection-v42-ledger", type: "DEBT_COLLECTION",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      customerId: "cust_s", amount: 500.5,
      cashMovementId: "DEBT-IN-v42-50050",
      cashMovement: {
        id: "DEBT-IN-v42-50050", opId: "collection-v42-ledger",
        type: "add", amount: 500.5, referenceType: "customer_debt",
        referenceId: "cust_s"
      },
      v42Ledger: {
        clientMovements: [
          {
            movementId: "CL-OPEN-cust_s-v42", clientId: "cust_s",
            type: "opening_balance", amountCentimes: 2600000,
            direction: "debit", referenceType: "opening_balance",
            referenceId: "cust_s", createdAt: "2026-10-28T12:00:00.000Z"
          },
          {
            movementId: "CL-REC-DEBT-IN-v42-50050", clientId: "cust_s",
            type: "receipt", amountCentimes: 50050,
            direction: "credit", referenceType: "customer_debt",
            referenceId: "cust_s", createdAt: "2026-10-28T12:00:00.000Z"
          }
        ],
        settlementAllocations: [{
          allocationId: "ALLOC-DEBT-IN-v42-50050-inv-collection-v42",
          partyType: "customer", partyId: "cust_s",
          invoiceType: "sales_invoice", invoiceId: "inv-collection-v42",
          sourceMovementId: "DEBT-IN-v42-50050",
          sourceMovementType: "customer_debt", amountCentimes: 50050,
          createdAt: "2026-10-28T12:00:00.000Z"
        }]
      }
    }
  };
  const result = reconcilePendingMutations(initial, [op]);
  assert.deepEqual(result.review, []);
  assert.equal(result.snapshot.customers[0].debt, 18999.5);
  assert.equal(result.snapshot.customers[0].ledgerVersion, 2);
  assert.equal(result.snapshot.caisseBalance, 54500.5);
  assert.equal(result.snapshot.cashMovements.filter(row => row.id === op.payload.cashMovementId).length, 1);
  assert.equal(result.snapshot.clientMovements.length, 2);
  assert.equal(result.snapshot.clientMovements.find(row => row.type === "opening_balance").amountCentimes, 1950000,
    "the opening balance must be rebased to the authoritative cloud debt, not stale local debt");
  assert.equal(result.snapshot.settlementAllocations.length, 1);
  const replay = reconcilePendingMutations(result.snapshot, [op]);
  assert.deepEqual(replay.review, []);
  assert.equal(replay.snapshot.cashMovements.length, result.snapshot.cashMovements.length);
  assert.equal(replay.snapshot.clientMovements.length, result.snapshot.clientMovements.length);
  assert.equal(replay.snapshot.settlementAllocations.length, result.snapshot.settlementAllocations.length);
});


test("quarantines a debt collection when another device has consumed the invoice FIFO balance", () => {
  const initial = cloud();
  initial.customers[0].debt = 1000;
  initial.invoices = [{
    id: "inv-overallocated", customerId: "cust_s",
    total: 1000, paid: 0, remaining: 1000
  }];
  initial.settlementAllocations = [{
    allocationId: "ALLOC-OTHER-DEVICE-900",
    partyType: "customer", partyId: "cust_s",
    invoiceType: "sales_invoice", invoiceId: "inv-overallocated",
    sourceMovementId: "DEBT-OTHER-DEVICE-900",
    sourceMovementType: "customer_debt", amountCentimes: 90000
  }];
  const op = {
    opId: "collection-overallocated-after-409",
    type: "DEBT_COLLECTION",
    createdAt: "2026-10-28T12:00:00.000Z",
    payload: {
      customerId: "cust_s",
      amount: 200,
      cashMovementId: "DEBT-IN-OVERALLOCATED-200",
      cashMovement: {
        id: "DEBT-IN-OVERALLOCATED-200",
        opId: "collection-overallocated-after-409",
        type: "add", amount: 200,
        referenceType: "customer_debt", referenceId: "cust_s"
      },
      v42Ledger: {
        clientMovements: [
          {
            movementId: "CL-OPEN-OVERALLOCATED", clientId: "cust_s",
            type: "opening_balance", amountCentimes: 120000,
            direction: "debit", referenceType: "opening_balance",
            referenceId: "cust_s", createdAt: "2026-10-28T12:00:00.000Z"
          },
          {
            movementId: "CL-REC-OVERALLOCATED", clientId: "cust_s",
            type: "receipt", amountCentimes: 20000,
            direction: "credit", referenceType: "customer_debt",
            referenceId: "cust_s", createdAt: "2026-10-28T12:00:00.000Z"
          }
        ],
        settlementAllocations: [{
          allocationId: "ALLOC-OVERALLOCATED-200",
          partyType: "customer", partyId: "cust_s",
          invoiceType: "sales_invoice", invoiceId: "inv-overallocated",
          sourceMovementId: "DEBT-IN-OVERALLOCATED-200",
          sourceMovementType: "customer_debt", amountCentimes: 20000,
          createdAt: "2026-10-28T12:00:00.000Z"
        }]
      }
    }
  };
  const result = reconcilePendingMutations(initial, [op]);
  assert.equal(result.review.length, 1);
  assert.equal(result.review[0].reason, "V42_COLLECTION_LEDGER_MISMATCH");
  assert.equal(result.snapshot.customers[0].debt, 1000);
  assert.equal(result.snapshot.caisseBalance, initial.caisseBalance);
  assert.equal(result.snapshot.cashMovements.some(row => row.id === op.payload.cashMovementId), false);
  assert.equal(result.snapshot.settlementAllocations.length, 1);
});
