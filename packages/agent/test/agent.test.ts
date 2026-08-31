import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTurnContext, CallRecord } from "@neuracall/orchestrator";
import { LlmCallAgent } from "../src/agent.js";
import type { LlmClient, LlmMessage, LlmRequest } from "../src/llm.js";
import { StaticLlmClient } from "../src/llm.js";
import type { TtsClient, TtsRequest } from "../src/tts.js";

const DEVICE = "SERIAL";
const CHANNEL = "cellular";

function turn(transcript: string, turnOrder = 0): AgentTurnContext {
  return {
    callId: "call-1",
    deviceId: DEVICE,
    channelId: CHANNEL,
    transcript,
    turnOrder,
    history: [],
  };
}

/** One request the test is holding open. */
interface PendingCall {
  prompt: string;
  resolve: (text: string) => void;
  /** True once it has been released or aborted. */
  settled: boolean;
}

/**
 * An LLM whose responses are released by the test, so turns can overlap.
 * Aborted requests are marked settled, so `release` always reaches the oldest
 * request that is genuinely still waiting rather than a dead one.
 */
class ControllableLlm implements LlmClient {
  readonly calls: Array<{ messages: LlmMessage[]; signal?: AbortSignal }> = [];
  readonly aborted: string[] = [];
  private readonly pending: PendingCall[] = [];

  async complete(request: LlmRequest): Promise<string> {
    this.calls.push({
      messages: request.messages,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const prompt = request.messages.at(-1)?.content ?? "";

    return new Promise<string>((resolve, reject) => {
      const call: PendingCall = { prompt, resolve, settled: false };
      this.pending.push(call);
      request.signal?.addEventListener("abort", () => {
        if (call.settled) return;
        call.settled = true;
        this.aborted.push(prompt);
        reject(new Error("aborted"));
      });
    });
  }

  get pendingCount(): number {
    return this.pending.filter((c) => !c.settled).length;
  }

  /** Release the oldest request that is still actually waiting. */
  release(text: string): void {
    const next = this.pending.find((c) => !c.settled);
    if (!next) throw new Error("no pending LLM request to release");
    next.settled = true;
    next.resolve(text);
  }
}

/**
 * An LLM that ignores the abort signal and always resolves — modelling a
 * provider whose response was already in flight when the abort landed. The
 * agent must discard the answer on its own rather than rely on the transport.
 */
class IgnoresAbortLlm implements LlmClient {
  constructor(private readonly replies: string[]) {}

  async complete(): Promise<string> {
    await new Promise((r) => setTimeout(r, 10));
    return this.replies.shift() ?? "unexpected extra call";
  }
}

class RecordingTts implements TtsClient {
  readonly requests: string[] = [];
  readonly aborted: string[] = [];

  async synthesize(request: TtsRequest): Promise<{
    pcm: Uint8Array;
    sampleRate: 16000;
    channels: 1;
  }> {
    this.requests.push(request.text);
    if (request.signal?.aborted) this.aborted.push(request.text);
    return { pcm: new Uint8Array(3200), sampleRate: 16000, channels: 1 };
  }
}

/** Let pending microtasks run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

test("a caller turn produces a spoken reply and is remembered", async () => {
  const tts = new RecordingTts();
  const agent = new LlmCallAgent({
    llm: new StaticLlmClient("We open at nine."),
    tts,
    keyterms: ["NeuraCall"],
  });

  const reply = await agent.onFinalTurn(turn("what time do you open?"));

  assert.ok(reply);
  assert.equal(reply.text, "We open at nine.");
  assert.equal(reply.sampleRate, 16000);
  assert.equal(reply.channels, 1);
  assert.equal(reply.audio?.length, 3200);
  assert.deepEqual(reply.keyterms, ["NeuraCall"]);
  assert.deepEqual(tts.requests, ["We open at nine."]);

  const conversation = agent.conversations.peek(DEVICE, CHANNEL)!;
  assert.deepEqual(
    conversation.all.map((m) => `${m.role}: ${m.content}`),
    ["user: what time do you open?", "assistant: We open at nine."],
  );
});

test("barge-in: a new caller turn cancels the reply still being generated", async () => {
  const llm = new ControllableLlm();
  const tts = new RecordingTts();
  const skips: string[] = [];
  const agent = new LlmCallAgent({
    llm,
    tts,
    onSkip: (_ctx, reason) => skips.push(reason),
  });

  // The caller asks something; the model starts composing a long answer.
  const first = agent.onFinalTurn(turn("tell me about your terms and conditions", 0));
  await tick();
  assert.equal(llm.pendingCount, 1);
  assert.equal(agent.isGenerating(DEVICE, CHANNEL), true);

  // The caller cuts in before the agent has said anything.
  const second = agent.onFinalTurn(turn("actually, just put me through to a human", 1));
  await tick();

  // The superseded request was aborted, not merely ignored.
  assert.deepEqual(llm.aborted, ["tell me about your terms and conditions"]);
  assert.equal(agent.interruptedCount, 1);

  // The interrupted turn says nothing at all.
  assert.equal(await first, null);
  assert.deepEqual(skips, ["interrupted"]);

  // The agent answers what the caller actually just said.
  llm.release("Of course, connecting you now.");
  const reply = await second;
  assert.ok(reply);
  assert.equal(reply.text, "Of course, connecting you now.");

  // The abandoned reply was never synthesised, so it can never be heard.
  assert.deepEqual(tts.requests, ["Of course, connecting you now."]);

  // Only the surviving exchange is in the history.
  const history = agent.conversations.peek(DEVICE, CHANNEL)!.all;
  assert.deepEqual(
    history.map((m) => `${m.role}: ${m.content}`),
    [
      "user: tell me about your terms and conditions",
      "user: actually, just put me through to a human",
      "assistant: Of course, connecting you now.",
    ],
  );
});

test("a reply that arrives after the interruption is discarded, not spoken", async () => {
  // This provider ignores the abort entirely, so the stale answer really does
  // come back — the agent has to throw it away itself.
  const tts = new RecordingTts();
  const agent = new LlmCallAgent({
    llm: new IgnoresAbortLlm(["stale answer", "fresh answer"]),
    tts,
  });

  const first = agent.onFinalTurn(turn("question one", 0));
  const second = agent.onFinalTurn(turn("question two", 1));

  assert.equal(await first, null, "a stale answer must never reach the caller");
  assert.equal((await second)?.text, "fresh answer");

  // The abandoned answer was never synthesised, so it could never be heard.
  assert.ok(!tts.requests.includes("stale answer"));
  assert.deepEqual(tts.requests, ["fresh answer"]);
});

test("the model sees the running conversation, not just the latest turn", async () => {
  const llm = new ControllableLlm();
  const agent = new LlmCallAgent({ llm, systemPrompt: "Be brief." });

  const first = agent.onFinalTurn(turn("my name is Alice", 0));
  await tick();
  llm.release("Nice to meet you, Alice.");
  await first;

  const second = agent.onFinalTurn(turn("what is my name?", 1));
  await tick();
  llm.release("Alice.");
  await second;

  assert.deepEqual(llm.calls[1]!.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "my name is Alice" },
    { role: "assistant", content: "Nice to meet you, Alice." },
    { role: "user", content: "what is my name?" },
  ]);
});

test("context is per device and channel, so calls never bleed into each other", async () => {
  const agent = new LlmCallAgent({ llm: new StaticLlmClient("ok") });

  await agent.onFinalTurn({ ...turn("cellular secret"), deviceId: "PHONE-A" });
  await agent.onFinalTurn({ ...turn("whatsapp secret"), deviceId: "PHONE-A", channelId: "whatsapp" });
  await agent.onFinalTurn({ ...turn("other phone"), deviceId: "PHONE-B" });

  assert.equal(agent.conversations.size, 3);
  const cellular = agent.conversations.peek("PHONE-A", "cellular")!;
  assert.deepEqual(
    cellular.all.filter((m) => m.role === "user").map((m) => m.content),
    ["cellular secret"],
  );
  const whatsapp = agent.conversations.peek("PHONE-A", "whatsapp")!;
  assert.deepEqual(
    whatsapp.all.filter((m) => m.role === "user").map((m) => m.content),
    ["whatsapp secret"],
  );
});

test("voice and text on the same line share one context", async () => {
  const llm = new ControllableLlm();
  const agent = new LlmCallAgent({ llm, systemPrompt: "Be brief." });

  // A text arrives first, then the same person rings.
  agent.noteTextMessage(DEVICE, CHANNEL, "user", "hi, my order is #4815");
  agent.noteTextMessage(DEVICE, CHANNEL, "assistant", "Thanks, let me look that up.");

  const call = agent.onFinalTurn(turn("did you find my order?", 0));
  await tick();

  assert.deepEqual(
    llm.calls[0]!.messages.map((m) => m.content),
    [
      "Be brief.",
      "hi, my order is #4815",
      "Thanks, let me look that up.",
      "did you find my order?",
    ],
  );
  llm.release("Yes, it ships tomorrow.");
  await call;
});

test("a greeting is spoken when the call is answered", async () => {
  const agent = new LlmCallAgent({
    llm: new StaticLlmClient("unused"),
    greeting: "Hello, thanks for calling.",
  });

  const reply = await agent.onAnswered({
    callId: "call-1",
    deviceId: DEVICE,
    channelId: CHANNEL,
    history: [],
  });

  assert.equal(reply?.text, "Hello, thanks for calling.");
  // The greeting is part of the history, so the model knows it already spoke.
  assert.deepEqual(
    agent.conversations.peek(DEVICE, CHANNEL)!.all.map((m) => m.content),
    ["Hello, thanks for calling."],
  );
});

test("no greeting configured means the agent waits for the caller", async () => {
  const agent = new LlmCallAgent({ llm: new StaticLlmClient("x") });
  assert.equal(
    await agent.onAnswered({ callId: "c", deviceId: DEVICE, channelId: CHANNEL, history: [] }),
    null,
  );
});

test("an empty or failed model reply leaves the agent silent rather than crashing", async () => {
  const skips: Array<{ reason: string; message?: string }> = [];
  const failing: LlmClient = {
    async complete() {
      throw new Error("provider is down");
    },
  };

  const quiet = new LlmCallAgent({
    llm: new StaticLlmClient("   "),
    onSkip: (_c, reason) => skips.push({ reason }),
  });
  assert.equal(await quiet.onFinalTurn(turn("hello")), null);

  const broken = new LlmCallAgent({
    llm: failing,
    onSkip: (_c, reason, err) => skips.push({ reason, ...(err ? { message: err.message } : {}) }),
  });
  assert.equal(await broken.onFinalTurn(turn("hello")), null);

  assert.deepEqual(skips, [
    { reason: "empty-reply" },
    { reason: "error", message: "provider is down" },
  ]);
});

test("ending a call aborts any reply still being generated", async () => {
  const llm = new ControllableLlm();
  const agent = new LlmCallAgent({ llm });

  const pending = agent.onFinalTurn(turn("are you there?"));
  await tick();
  assert.equal(agent.isGenerating(DEVICE, CHANNEL), true);

  await agent.onCallEnded({ deviceId: DEVICE, channelId: CHANNEL } as CallRecord);

  assert.equal(await pending, null);
  assert.deepEqual(llm.aborted, ["are you there?"]);
  assert.equal(agent.isGenerating(DEVICE, CHANNEL), false);
});
