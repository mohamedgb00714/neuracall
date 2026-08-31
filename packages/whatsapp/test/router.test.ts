import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmCallAgent, StaticLlmClient } from "@neuracall/agent";
import type { AgentReply, AgentTurnContext } from "@neuracall/orchestrator";
import { TEXT_CHANNEL_ID, TextMessageRouter, type TextAgent } from "../src/router.js";
import type { InboundTextMessage } from "../src/types.js";
import { FakeTransport, inbound } from "./fakeTransport.js";

const DEVICE = "SERIAL";

function voiceTurn(transcript: string, turnOrder = 1): AgentTurnContext {
  return {
    callId: "call-1",
    deviceId: DEVICE,
    channelId: "whatsapp",
    transcript,
    turnOrder,
    history: [],
  };
}

/** An agent that only answers; it keeps no conversation of its own. */
class ReplyOnlyAgent implements TextAgent {
  readonly turns: AgentTurnContext[] = [];
  readonly noted: Array<{ deviceId: string; channelId: string; role: string; content: string }> =
    [];
  /** Set to make the next turn reject. */
  failNext: Error | null = null;

  constructor(private readonly reply: string | null = "sure") {}

  async onFinalTurn(ctx: AgentTurnContext): Promise<AgentReply | null> {
    this.turns.push(ctx);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return this.reply === null ? null : { text: this.reply };
  }

  noteTextMessage(
    deviceId: string,
    channelId: string,
    role: "user" | "assistant",
    content: string,
  ): void {
    this.noted.push({ deviceId, channelId, role, content });
  }
}

test("an inbound message is answered through the transport", async () => {
  const transport = new FakeTransport();
  const agent = new ReplyOnlyAgent("We open at nine.");
  const replies: string[] = [];
  const router = new TextMessageRouter({
    agent,
    transport,
    deviceId: DEVICE,
    onReply: (_msg: InboundTextMessage, reply: string) => replies.push(reply),
  });

  await router.start();
  transport.deliver(inbound({ from: "212600000001", text: "  what time do you open?  " }));
  await router.drain();

  assert.deepEqual(transport.sent, [{ to: "212600000001", text: "We open at nine." }]);
  assert.deepEqual(replies, ["We open at nine."]);

  const turn = agent.turns[0];
  assert.ok(turn);
  assert.equal(turn.transcript, "what time do you open?");
  assert.equal(turn.deviceId, DEVICE);
  // The conversation channel is the voice one, so history is shared; the call
  // id is what marks the turn as having arrived as text.
  assert.equal(turn.channelId, "whatsapp");
  assert.ok(turn.callId.startsWith(`${TEXT_CHANNEL_ID}:`));

  await router.stop();
  assert.equal(transport.startCount, 1);
  assert.equal(transport.stopCount, 1);
  assert.equal(transport.listeners.size, 0);
});

test("text and voice on one number share a conversation", async () => {
  const transport = new FakeTransport();
  const agent = new LlmCallAgent({ llm: new StaticLlmClient("Nine in the morning.") });
  const router = new TextMessageRouter({ agent, transport, deviceId: DEVICE });

  // The customer rings first...
  await agent.onFinalTurn(voiceTurn("what time do you open?"));
  // ...then texts the same number.
  await router.handle(inbound({ text: "and on Sunday?" }));

  assert.equal(transport.sent.length, 1);

  // One conversation, not two: the text turn landed in the same history the
  // call is using.
  assert.deepEqual(agent.conversations.keys, [`${DEVICE}::whatsapp`]);
  const conversation = agent.conversations.peek(DEVICE, "whatsapp");
  assert.ok(conversation);
  assert.deepEqual(
    conversation.all.map((m) => m.content),
    ["what time do you open?", "Nine in the morning.", "and on Sunday?", "Nine in the morning."],
  );

  // And a later voice turn is prompted with the texted question in context.
  const seen: string[] = [];
  const recording = new LlmCallAgent({
    llm: {
      async complete(req) {
        seen.push(...req.messages.map((m) => m.content));
        return "ok";
      },
    },
  });
  await new TextMessageRouter({ agent: recording, transport, deviceId: DEVICE }).handle(
    inbound({ text: "hello there" }),
  );
  await recording.onFinalTurn(voiceTurn("still there?", 2));
  assert.ok(seen.includes("hello there"));
});

test("a redelivered message is answered exactly once", async () => {
  const transport = new FakeTransport();
  const agent = new ReplyOnlyAgent("Got it.");
  const duplicates: string[] = [];
  const router = new TextMessageRouter({
    agent,
    transport,
    deviceId: DEVICE,
    onDuplicate: (msg: InboundTextMessage) => duplicates.push(msg.messageId),
  });

  const message = inbound({ messageId: "wamid.RETRY", text: "book me a table" });
  await router.start();

  // Meta retries the whole delivery, and the retry usually arrives while the
  // first turn is still generating.
  transport.deliver(message);
  transport.deliver({ ...message });
  transport.deliver({ ...message });
  await router.drain();

  assert.equal(agent.turns.length, 1);
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(duplicates, ["wamid.RETRY", "wamid.RETRY"]);
});

test("the dedup set is bounded", async () => {
  const transport = new FakeTransport();
  const router = new TextMessageRouter({
    agent: new ReplyOnlyAgent("ok"),
    transport,
    deviceId: DEVICE,
    maxSeenMessages: 3,
  });

  for (let i = 0; i < 10; i += 1) {
    await router.handle(inbound({ messageId: `wamid.${i}` }));
  }
  assert.equal(router.seenCount, 3);

  // The oldest ids were evicted, so a very old redelivery is answered again —
  // the deliberate trade for a set that cannot grow without limit.
  await router.handle(inbound({ messageId: "wamid.0" }));
  assert.equal(transport.sent.length, 11);
  // The most recent one is still deduplicated.
  await router.handle(inbound({ messageId: "wamid.9" }));
  assert.equal(transport.sent.length, 11);
});

test("turns on one conversation are serialised rather than treated as barge-in", async () => {
  const transport = new FakeTransport();
  let inFlight = 0;
  let maxInFlight = 0;
  const agent: TextAgent = {
    async onFinalTurn(ctx) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { text: `re: ${ctx.transcript}` };
    },
  };
  const router = new TextMessageRouter({ agent, transport, deviceId: DEVICE });

  await router.start();
  transport.deliver(inbound({ text: "first" }));
  transport.deliver(inbound({ text: "second" }));
  await router.drain();

  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    transport.sent.map((s) => s.text),
    ["re: first", "re: second"],
  );
});

test("an agent failure or a send failure is reported, not thrown", async () => {
  const transport = new FakeTransport();
  const agent = new ReplyOnlyAgent("fine");
  const errors: string[] = [];
  const router = new TextMessageRouter({
    agent,
    transport,
    deviceId: DEVICE,
    onError: (_msg: InboundTextMessage, err: Error) => errors.push(err.message),
  });

  agent.failNext = new Error("model unavailable");
  await router.handle(inbound({ text: "one" }));
  assert.equal(transport.sent.length, 0);

  transport.failNextSend = new Error("outside the 24-hour window");
  await router.handle(inbound({ text: "two" }));
  assert.equal(transport.sent.length, 0);

  await router.handle(inbound({ text: "three" }));
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(errors, ["model unavailable", "outside the 24-hour window"]);
});

test("nothing is sent when the agent stays quiet or the text is empty", async () => {
  const transport = new FakeTransport();
  const silent = new ReplyOnlyAgent(null);
  const router = new TextMessageRouter({ agent: silent, transport, deviceId: DEVICE });

  await router.handle(inbound({ text: "hello" }));
  await router.handle(inbound({ text: "   " }));

  assert.equal(transport.sent.length, 0);
  assert.equal(silent.turns.length, 1);
});

test("recordTurns writes both sides into the shared conversation as text", async () => {
  const transport = new FakeTransport();
  const agent = new ReplyOnlyAgent("Yes, until six.");
  const router = new TextMessageRouter({
    agent,
    transport,
    deviceId: DEVICE,
    recordTurns: true,
  });

  await router.handle(inbound({ text: "open on Sunday?" }));

  assert.deepEqual(agent.noted, [
    { deviceId: DEVICE, channelId: "whatsapp", role: "user", content: "open on Sunday?" },
    { deviceId: DEVICE, channelId: "whatsapp", role: "assistant", content: "Yes, until six." },
  ]);
});

test("recordTurns stays off by default so a self-recording agent is not duplicated", async () => {
  const transport = new FakeTransport();
  const agent = new LlmCallAgent({ llm: new StaticLlmClient("Sure.") });
  const router = new TextMessageRouter({ agent, transport, deviceId: DEVICE });

  await router.handle(inbound({ text: "a question" }));

  const conversation = agent.conversations.peek(DEVICE, "whatsapp");
  assert.equal(conversation?.length, 2);
});

test("an unsolicited outbound message is recorded on the shared conversation", async () => {
  const transport = new FakeTransport();
  const agent = new LlmCallAgent({ llm: new StaticLlmClient("unused") });
  const router = new TextMessageRouter({ agent, transport, deviceId: DEVICE });

  await router.sendText("212600000001", "Your table is confirmed for eight.");
  await router.sendText("212600000001", "   ");

  assert.deepEqual(transport.sent, [
    { to: "212600000001", text: "Your table is confirmed for eight." },
  ]);
  const conversation = agent.conversations.peek(DEVICE, "whatsapp");
  assert.deepEqual(
    conversation?.all.map((m) => [m.role, m.via, m.content]),
    [["assistant", "text", "Your table is confirmed for eight."]],
  );
});

test("conversationDeviceId gives each contact its own thread when asked", async () => {
  const transport = new FakeTransport();
  const agent = new LlmCallAgent({ llm: new StaticLlmClient("ok") });
  const router = new TextMessageRouter({
    agent,
    transport,
    deviceId: DEVICE,
    conversationDeviceId: (msg: InboundTextMessage) => `${DEVICE}:${msg.from}`,
  });

  await router.handle(inbound({ from: "aaa", text: "hi" }));
  await router.handle(inbound({ from: "bbb", text: "hi" }));

  assert.deepEqual(agent.conversations.keys.sort(), [
    `${DEVICE}:aaa::whatsapp`,
    `${DEVICE}:bbb::whatsapp`,
  ]);
});

test("a message carrying its own device id wins over the router default", async () => {
  const transport = new FakeTransport();
  const agent = new ReplyOnlyAgent("ok");
  const router = new TextMessageRouter({ agent, transport, deviceId: DEVICE });

  await router.handle(inbound({ deviceId: "OTHER", text: "hi" }));

  assert.equal(agent.turns[0]?.deviceId, "OTHER");
});
