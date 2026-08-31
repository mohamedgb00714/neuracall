import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversation, ConversationStore } from "../src/conversation.js";

test("a conversation records both sides in order", () => {
  let clock = 1000;
  const c = new Conversation("SERIAL", "cellular", { now: () => (clock += 10) });

  c.appendUser("hello");
  c.appendAgent("hi, how can I help?");
  c.appendUser("book a table");

  assert.deepEqual(
    c.all.map((m) => `${m.role}/${m.via}: ${m.content}`),
    ["user/voice: hello", "assistant/voice: hi, how can I help?", "user/voice: book a table"],
  );
  assert.equal(c.length, 3);
  assert.equal(c.lastActivityAt, clock);
});

test("the window is trimmed but the full history is kept", () => {
  const c = new Conversation("SERIAL", "cellular", { maxMessages: 3 });
  for (let i = 0; i < 6; i++) c.appendUser(`turn ${i}`);

  // The model only sees the recent window...
  assert.deepEqual(
    c.window.map((m) => m.content),
    ["turn 3", "turn 4", "turn 5"],
  );
  // ...but the transcript keeps everything.
  assert.equal(c.all.length, 6);
});

test("text messages join the same history as voice", () => {
  const c = new Conversation("SERIAL", "whatsapp");
  c.appendText("user", "my order is #4815");
  c.appendUser("did you find it?");

  assert.deepEqual(
    c.all.map((m) => m.via),
    ["text", "voice"],
  );
});

test("the store keys conversations by device and channel", () => {
  const store = new ConversationStore();
  const a = store.for("PHONE-A", "cellular");
  const b = store.for("PHONE-A", "whatsapp");
  const c = store.for("PHONE-B", "cellular");

  assert.notEqual(a, b, "same phone, different channel is a different context");
  assert.notEqual(a, c, "same channel, different phone is a different context");
  assert.equal(store.for("PHONE-A", "cellular"), a, "the same pair returns the same context");
  assert.equal(store.size, 3);
  assert.equal(ConversationStore.key("PHONE-A", "cellular"), "PHONE-A::cellular");
});

test("peek does not create a conversation", () => {
  const store = new ConversationStore();
  assert.equal(store.peek("PHONE-A", "cellular"), undefined);
  assert.equal(store.size, 0);
  store.for("PHONE-A", "cellular");
  assert.ok(store.peek("PHONE-A", "cellular"));
});

test("idle conversations are evicted so the store cannot grow forever", () => {
  let clock = 100_000;
  const store = new ConversationStore({ idleTtlMs: 1000, now: () => clock });

  store.for("PHONE-A", "cellular").appendUser("old");
  clock += 500;
  store.for("PHONE-B", "cellular").appendUser("recent");

  clock += 700; // A is now 1200 ms idle, B is 700 ms idle
  assert.equal(store.evictIdle(), 1);
  assert.deepEqual(store.keys, ["PHONE-B::cellular"]);
});

test("dropping a conversation forgets the caller", () => {
  const store = new ConversationStore();
  store.for("PHONE-A", "cellular").appendUser("secret");

  assert.equal(store.drop("PHONE-A", "cellular"), true);
  assert.equal(store.drop("PHONE-A", "cellular"), false);
  assert.equal(store.peek("PHONE-A", "cellular"), undefined);
});
