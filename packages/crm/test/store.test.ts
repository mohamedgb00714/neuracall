import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallRecord, CallRecordStore } from "@neuracall/orchestrator";
import { CrmStore } from "../src/store.js";
import { CRM_SCHEMA_VERSION, userVersion } from "../src/schema.js";
import type { CrmStoreOptions } from "../src/types.js";

/** A store on ":memory:" with deterministic ids and clock. */
function makeStore(options: CrmStoreOptions = {}): CrmStore {
  let tick = 0;
  let id = 0;
  return new CrmStore({
    path: ":memory:",
    now: () => 1_000 + tick++,
    newId: () => `contact-${++id}`,
    ...options,
  });
}

function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    deviceId: "SERIAL",
    channelId: "cellular",
    direction: "inbound",
    state: "ended",
    outcome: "completed",
    remoteParty: null,
    startedAt: 1000,
    answeredAt: 1100,
    endedAt: 2000,
    transcript: [{ speaker: "caller", text: "hello", at: 1200 }],
    audioPath: null,
    states: [{ state: "idle", at: 1000 }],
    ...overrides,
  };
}

test("open() migrates an empty database", () => {
  const store = makeStore();
  try {
    assert.equal(userVersion(store.db), CRM_SCHEMA_VERSION);
    // Migrating twice is a no-op, not an error.
    assert.equal(userVersion(store.db), CRM_SCHEMA_VERSION);
    assert.deepEqual(store.listContacts(), []);
  } finally {
    store.close();
  }
});

test("a contact round-trips with its phones and tags", () => {
  const store = makeStore({ defaultCountryCode: "1" });
  try {
    const created = store.createContact({
      displayName: "Ada Lovelace",
      org: "Analytical Engines",
      notes: "prefers email",
      phones: ["+1 (555) 010-9999"],
      tags: ["vip", "eng"],
    });

    assert.equal(created.id, "contact-1");
    assert.equal(created.displayName, "Ada Lovelace");
    assert.equal(created.org, "Analytical Engines");
    assert.equal(created.notes, "prefers email");
    assert.deepEqual(created.tags, ["eng", "vip"]);
    assert.deepEqual(created.phones, [
      { e164: "+15550109999", suffix: "0109999", raw: "+1 (555) 010-9999" },
    ]);

    assert.deepEqual(store.getContact("contact-1"), created);
    assert.equal(store.getContact("nope"), undefined);
    assert.deepEqual(
      store.listContacts().map((c) => c.id),
      ["contact-1"],
    );
    assert.deepEqual(
      store.listContacts({ search: "analytical" }).map((c) => c.id),
      ["contact-1"],
    );
    assert.deepEqual(store.listContacts({ search: "babbage" }), []);
    assert.deepEqual(
      store.listContacts({ tag: "vip" }).map((c) => c.id),
      ["contact-1"],
    );
    assert.deepEqual(store.listContacts({ tag: "nope" }), []);
  } finally {
    store.close();
  }
});

test("the three ways of writing one number all find the same contact", () => {
  const store = makeStore({ defaultCountryCode: "1" });
  try {
    const ada = store.createContact({ displayName: "Ada", phones: ["+1 (555) 010-9999"] });

    for (const raw of ["+1 (555) 010-9999", "555-010-9999", "5550109999"]) {
      assert.equal(store.findContactByPhone(raw)?.id, ada.id, `"${raw}" must find the contact`);
    }
    assert.equal(store.findContactByPhone("+1 555 010 9998"), undefined);
    assert.equal(store.findContactByPhone("withheld"), undefined);
  } finally {
    store.close();
  }
});

test("the suffix fallback links a number typed without a country code", () => {
  // No defaultCountryCode: "555-010-9999" cannot be promoted to E.164, so only
  // the trailing-digit fallback can match it.
  const store = makeStore();
  try {
    const ada = store.createContact({ displayName: "Ada", phones: ["+1 555 010 9999"] });
    assert.equal(store.findContactByPhone("555-010-9999")?.id, ada.id);
  } finally {
    store.close();
  }
});

test("an ambiguous suffix is refused rather than guessed", () => {
  const store = makeStore();
  try {
    // Both numbers end in 0109999 but belong to different people.
    store.createContact({ displayName: "Ada", phones: ["+1 555 010 9999"] });
    store.createContact({ displayName: "Grace", phones: ["+44 20 7010 9999"] });

    assert.equal(store.findContactsByPhone("555-010-9999").length, 2);
    assert.equal(store.findContactByPhone("555-010-9999"), undefined);
    // An exact key is still unambiguous.
    assert.equal(store.findContactByPhone("+44 20 7010 9999")?.displayName, "Grace");
  } finally {
    store.close();
  }
});

test("addPhone is idempotent and drops numbers with no digits", () => {
  const store = makeStore({ defaultCountryCode: "1" });
  try {
    const ada = store.createContact({ displayName: "Ada" });
    store.addPhone(ada.id, "+1 (555) 010-9999");
    store.addPhone(ada.id, "5550109999");
    assert.equal(store.getContact(ada.id)?.phones.length, 1, "one number, three spellings");

    assert.equal(store.addPhone(ada.id, "unknown"), null);
    assert.equal(store.getContact(ada.id)?.phones.length, 1);

    assert.equal(store.removePhone(ada.id, "555 010 9999"), true);
    assert.deepEqual(store.getContact(ada.id)?.phones, []);
  } finally {
    store.close();
  }
});

test("upsertCall is idempotent by callId", () => {
  const store = makeStore();
  try {
    store.upsertCall(record({ state: "answered", outcome: null }));
    store.upsertCall(record({ state: "ended", outcome: "completed" }));

    assert.equal(store.recentCalls().length, 1, "an upsert must not duplicate the call");
    const stored = store.getCall("call-1");
    assert.equal(stored?.state, "ended");
    assert.equal(stored?.outcome, "completed");
  } finally {
    store.close();
  }
});

test("a re-save does not drop a link the CRM already made", () => {
  const store = makeStore({ defaultCountryCode: "1" });
  try {
    const ada = store.createContact({ displayName: "Ada", phones: ["+1 555 010 9999"] });
    store.upsertCall(record({ remoteParty: "+15550109999" }));
    assert.equal(store.linkCallToContact("call-1", ada.id), true);

    store.upsertCall(record({ remoteParty: "+15550109999", state: "ended" }));
    assert.equal(store.getCall("call-1")?.contactId, ada.id);

    assert.equal(store.linkCallToContact("call-1", null), true);
    assert.equal(store.getCall("call-1")?.contactId, null);
    assert.equal(store.linkCallToContact("no-such-call", ada.id), false);
  } finally {
    store.close();
  }
});

test("autoLinkCall matches on the remote party and creates nothing", () => {
  const store = makeStore({ defaultCountryCode: "1" });
  try {
    const ada = store.createContact({ displayName: "Ada", phones: ["+1 (555) 010-9999"] });

    store.upsertCall(record({ callId: "known", remoteParty: "555-010-9999" }));
    assert.equal(store.autoLinkCall("known"), ada.id);
    assert.equal(store.getCall("known")?.contactId, ada.id);

    store.upsertCall(record({ callId: "stranger", remoteParty: "+1 555 010 1111" }));
    assert.equal(store.autoLinkCall("stranger"), undefined);
    assert.equal(store.getCall("stranger")?.contactId, null);
    assert.equal(store.listContacts().length, 1, "auto-linking must not invent a contact");

    store.upsertCall(record({ callId: "withheld", remoteParty: null }));
    assert.equal(store.autoLinkCall("withheld"), undefined);
    assert.equal(store.autoLinkCall("no-such-call"), undefined);
  } finally {
    store.close();
  }
});

test("two calls from one number group under one contact", () => {
  const store = makeStore({ defaultCountryCode: "1" });
  try {
    const ada = store.createContact({ displayName: "Ada", phones: ["+1 (555) 010-9999"] });

    store.upsertCall(record({ callId: "a", remoteParty: "+15550109999", startedAt: 100 }));
    store.upsertCall(record({ callId: "b", remoteParty: "555-010-9999", startedAt: 300 }));
    store.upsertCall(record({ callId: "c", remoteParty: "+1 555 010 1111", startedAt: 200 }));
    for (const id of ["a", "b", "c"]) store.autoLinkCall(id);

    assert.deepEqual(
      store.callsForContact(ada.id).map((c) => c.callId),
      ["b", "a"],
    );

    const groups = store.groupByContact();
    assert.equal(groups.length, 2, "one group for Ada, one for the unknown caller");

    const adaGroup = groups.find((g) => g.contact?.id === ada.id);
    assert.equal(adaGroup?.callCount, 2);
    assert.equal(adaGroup?.firstCallAt, 100);
    assert.equal(adaGroup?.lastCallAt, 300);

    const unknown = groups.find((g) => g.contact === null);
    assert.equal(unknown?.callCount, 1);

    assert.deepEqual(
      store.groupByContact({ includeUnlinked: false }).map((g) => g.contact?.id),
      [ada.id],
    );
  } finally {
    store.close();
  }
});

test("transcripts and state history survive a round-trip", () => {
  const store = makeStore();
  try {
    const original = record({
      transcript: [
        { speaker: "caller", text: "is this thing on?", at: 1200, turnOrder: 1 },
        { speaker: "agent", text: "it is", at: 1300 },
      ],
      states: [
        { state: "idle", at: 1000 },
        { state: "incoming", at: 1010, reason: "ring" },
        { state: "ended", at: 2000 },
      ],
      audioPath: "/tmp/call-1.wav",
    });
    store.upsertCall(original);

    const stored = store.getCall("call-1");
    assert.deepEqual(stored?.transcript, original.transcript);
    assert.deepEqual(stored?.states, original.states);
    assert.equal(stored?.audioPath, "/tmp/call-1.wav");
    assert.ok(stored !== undefined && !("error" in stored), "an absent error must stay absent");

    store.upsertCall(
      record({ callId: "broken", state: "ended", outcome: "failed", error: "websocket died" }),
    );
    assert.equal(store.getCall("broken")?.error, "websocket died");
  } finally {
    store.close();
  }
});

/** The contract `JsonlCallRecordStore` already satisfies. */
test("CrmStore is a drop-in CallRecordStore", async () => {
  const store = makeStore({ defaultCountryCode: "1" });
  const asStore: CallRecordStore = store;
  try {
    assert.equal(await asStore.get("call-1"), undefined);

    await asStore.save(record({ state: "answered", outcome: null }));
    await asStore.save(record({ state: "ended", outcome: "completed" }));
    const found = await asStore.get("call-1");
    assert.equal(found?.state, "ended");
    assert.equal(found?.outcome, "completed");
    assert.equal((await asStore.list()).length, 1, "save is an upsert, not an append");
    assert.equal(found?.transcript[0]?.text, "hello");

    await asStore.save(record({ callId: "a", startedAt: 100, deviceId: "PHONE-1" }));
    await asStore.save(record({ callId: "b", startedAt: 300, deviceId: "PHONE-2" }));
    await asStore.save(record({ callId: "c", startedAt: 200, deviceId: "PHONE-1" }));

    // call-1 started at 1000, the others at 100/200/300: newest first.
    assert.deepEqual(
      (await asStore.list()).map((r) => r.callId),
      ["call-1", "b", "c", "a"],
    );
    assert.deepEqual(
      (await asStore.list({ deviceId: "PHONE-1" })).map((r) => r.callId),
      ["c", "a"],
    );
    assert.deepEqual(
      (await asStore.list({ limit: 2 })).map((r) => r.callId),
      ["call-1", "b"],
    );
  } finally {
    store.close();
  }
});

test("save() auto-links to a known contact, and can be told not to", async () => {
  const linking = makeStore({ defaultCountryCode: "1" });
  try {
    const ada = linking.createContact({ displayName: "Ada", phones: ["+1 (555) 010-9999"] });
    await linking.save(record({ remoteParty: "555-010-9999" }));
    assert.equal(linking.getCall("call-1")?.contactId, ada.id);
  } finally {
    linking.close();
  }

  const plain = makeStore({ defaultCountryCode: "1", autoLinkOnSave: false });
  try {
    plain.createContact({ displayName: "Ada", phones: ["+1 (555) 010-9999"] });
    await plain.save(record({ remoteParty: "555-010-9999" }));
    assert.equal(plain.getCall("call-1")?.contactId, null);
  } finally {
    plain.close();
  }
});

test("a file-backed store reopens without re-running its migrations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neuracall-crm-"));
  const path = join(dir, "crm.db");
  try {
    const first = makeStore({ path, defaultCountryCode: "1" });
    const ada = first.createContact({ displayName: "Ada", phones: ["+1 (555) 010-9999"] });
    await first.save(record({ remoteParty: "555-010-9999" }));
    first.close();

    const reopened = makeStore({ path, defaultCountryCode: "1" });
    try {
      assert.equal(userVersion(reopened.db), CRM_SCHEMA_VERSION);
      assert.equal(reopened.findContactByPhone("5550109999")?.displayName, "Ada");
      assert.equal(reopened.getCall("call-1")?.contactId, ada.id);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting a contact leaves its calls, unlinked", () => {
  const store = makeStore({ defaultCountryCode: "1" });
  try {
    const ada = store.createContact({ displayName: "Ada", phones: ["+1 555 010 9999"] });
    store.upsertCall(record({ remoteParty: "+15550109999" }), ada.id);
    assert.equal(store.getCall("call-1")?.contactId, ada.id);

    store.db.prepare("DELETE FROM contacts WHERE id = ?").run(ada.id);
    assert.equal(store.getCall("call-1")?.contactId, null, "ON DELETE SET NULL must be enforced");
    assert.equal(store.getCall("call-1")?.callId, "call-1");
  } finally {
    store.close();
  }
});
