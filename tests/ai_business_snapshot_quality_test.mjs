import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("function anasBuildBusinessSnapshot(){");
const end = html.indexOf("function anasAiAppendMessage", start);
assert.notEqual(start, -1, "business snapshot builder must exist");
assert.notEqual(end, -1, "business snapshot builder must have a stable end boundary");
const builderSource = html.slice(start, end) + "\nthis.build = anasBuildBusinessSnapshot;";

function build(AppData) {
  const sandbox = { AppData };
  vm.runInNewContext(builderSource, sandbox);
  return sandbox.build();
}

test("preserves valid zero values and aggregates finite numeric strings", () => {
  const snapshot = build({
    products: [{ stock: "0", buyPrice: "12.5" }, { stock: "2", buyPrice: "10" }],
    customers: [{ debt: "0" }, { debt: "25" }],
    invoices: [{ total: "0" }, { total: 100 }],
    purchases: [{ total: 0, cost: 99, qty: 2 }, { cost: "5", qty: "3" }],
    expenses: [{ amt: "0" }, { amt: 7 }],
    truckTrips: [{ cost: 0, status: "delivered" }, { cost: "8", status: "in transit" }],
    caisseBalance: "0"
  });
  assert.equal(snapshot.totals.estimatedStockCostDZD, 20);
  assert.equal(snapshot.totals.customerDebtsDZD, 25);
  assert.equal(snapshot.totals.invoiceTotalsDZD, 100);
  assert.equal(snapshot.totals.purchaseRecordsTotalDZD, 15);
  assert.equal(snapshot.totals.recordedExpensesDZD, 7);
  assert.equal(snapshot.totals.recordedTruckTripCostsDZD, 8);
  assert.equal(snapshot.totals.cashBalanceDZD, 0);
  assert.equal(snapshot.dataQuality.hasIncompleteFinancialData, false);
});

test("does not silently convert missing, blank, nonnumeric, or infinite values to zero", () => {
  const snapshot = build({
    products: [{ stock: "", buyPrice: 5 }, { stock: 2, buyPrice: "unknown" }, { stock: 3, buyPrice: 4 }],
    customers: [{ debt: null }, { debt: "bad" }, { debt: 10 }],
    invoices: [{ total: undefined }, { total: "NaN" }, { total: 40 }],
    purchases: [{ total: "", cost: "bad", qty: 2 }, { cost: 5, qty: Infinity }],
    expenses: [{ amt: " " }, { amt: 3 }],
    truckTrips: [{ cost: "oops" }],
    caisseBalance: "not-a-number"
  });
  assert.equal(snapshot.totals.estimatedStockCostDZD, 12);
  assert.equal(snapshot.totals.customerDebtsDZD, 10);
  assert.equal(snapshot.totals.invoiceTotalsDZD, 40);
  assert.equal(snapshot.totals.purchaseRecordsTotalDZD, 0);
  assert.equal(snapshot.totals.recordedExpensesDZD, 3);
  assert.equal(snapshot.totals.recordedTruckTripCostsDZD, 0);
  assert.equal(snapshot.totals.cashBalanceDZD, null);
  assert.equal(snapshot.dataQuality.hasIncompleteFinancialData, true);
  assert.equal(snapshot.dataQuality.metricCoverage.estimatedStockCostDZD.invalidRecords, 2);
  assert.equal(snapshot.dataQuality.metricCoverage.invoiceTotalsDZD.invalidRecords, 2);
  assert.ok(snapshot.dataQuality.incompleteMetrics.includes("cashBalanceDZD"));
});

test("reports clean zero totals for empty datasets without flagging missing records", () => {
  const snapshot = build({ caisseBalance: 0 });
  assert.equal(snapshot.totals.invoiceTotalsDZD, 0);
  assert.equal(snapshot.totals.customerDebtsDZD, 0);
  assert.equal(snapshot.totals.cashBalanceDZD, 0);
  assert.equal(snapshot.dataQuality.hasIncompleteFinancialData, false);
  assert.deepEqual(Object.keys(snapshot.counts).sort(),
    ["customers","expenses","invoices","products","purchaseRecords","stockMovements","suppliers","truckTrips","warehouseTransfers","warehouses"].sort());
});

test("keeps the outbound snapshot aggregate-only and labels partial financial totals", () => {
  const snapshot = build({
    products: [{ name: "PRIVATE PRODUCT NAME", stock: 1, buyPrice: 2 }],
    customers: [{ name: "PRIVATE CUSTOMER NAME", debt: 3 }]
  });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("PRIVATE PRODUCT NAME"), false);
  assert.equal(serialized.includes("PRIVATE CUSTOMER NAME"), false);
  assert.match(snapshot.note, /جزئي/);
  assert.ok(snapshot.dataQuality.metricCoverage.customerDebtsDZD);
});
