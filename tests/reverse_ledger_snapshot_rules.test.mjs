import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const projectId = "demo-anas-erp";
const rules = await readFile(resolve("firebase/firestore.staging.rules"), "utf8");
const testEnv = await initializeTestEnvironment({
  projectId,
  firestore: { rules, host: "127.0.0.1", port: 8080 }
});
test.after(async () => testEnv.cleanup());

test("owner can use the legacy snapshot backup before a reverse-ledger grant exists", async () => {
  const uid = "snapshot-owner-before-grant";
  const db = testEnv.authenticatedContext(uid).firestore();
  await assertSucceeds(setDoc(doc(db, "users", uid, "snapshots", "latest"), {
    payload: JSON.stringify({ marker: "before-grant" })
  }));
  const snapshot = await assertSucceeds(getDoc(doc(db, "users", uid, "snapshots", "latest")));
  assert.equal(snapshot.get("payload"), JSON.stringify({ marker: "before-grant" }));
});

test("a trusted reverse-ledger grant locks legacy snapshot writes but preserves owner reads", async () => {
  const uid = "snapshot-owner-after-grant";
  await testEnv.withSecurityRulesDisabled(async adminContext => {
    await setDoc(doc(adminContext.firestore(), "users", uid, "snapshots", "latest"), {
      payload: JSON.stringify({ marker: "authoritative-posted-state" })
    });
    await setDoc(doc(adminContext.firestore(), "reverseLedgerGrants", uid), {
      uid, active: true, schemaVersion: 1, permissions: ["reverse_sale_return"]
    });
  });

  const ownerDb = testEnv.authenticatedContext(uid).firestore();
  const snapshotRef = doc(ownerDb, "users", uid, "snapshots", "latest");
  const read = await assertSucceeds(getDoc(snapshotRef));
  assert.equal(read.get("payload"), JSON.stringify({ marker: "authoritative-posted-state" }));

  await assertFails(setDoc(snapshotRef, {
    payload: JSON.stringify({ marker: "stale-legacy-worker-overwrite" })
  }));

  const adminSnapshot = await testEnv.withSecurityRulesDisabled(context =>
    getDoc(doc(context.firestore(), "users", uid, "snapshots", "latest"))
  );
  assert.equal(adminSnapshot.get("payload"), JSON.stringify({ marker: "authoritative-posted-state" }));
});

test("another user cannot read or overwrite the owner's snapshot", async () => {
  const ownerUid = "snapshot-owner-isolated";
  await testEnv.withSecurityRulesDisabled(context =>
    setDoc(doc(context.firestore(), "users", ownerUid, "snapshots", "latest"), {
      payload: JSON.stringify({ marker: "private" })
    })
  );
  const otherDb = testEnv.authenticatedContext("different-user").firestore();
  const ref = doc(otherDb, "users", ownerUid, "snapshots", "latest");
  await assertFails(getDoc(ref));
  await assertFails(setDoc(ref, { payload: "{}" }));
});

test("client users cannot read or mutate reverse-ledger control-plane documents", async () => {
  const uid = "snapshot-control-plane-user";
  const db = testEnv.authenticatedContext(uid).firestore();
  await assertFails(getDoc(doc(db, "reverseLedgerGrants", uid)));
  await assertFails(setDoc(doc(db, "reverseLedgerOperations", "REV-OP-00000001"), {
    ownerUid: uid, status: "POSTED"
  }));
  await assertFails(getDoc(doc(db, "financialPeriods", "FY-2026-10")));
});
