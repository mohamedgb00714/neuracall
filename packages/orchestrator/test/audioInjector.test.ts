import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  CommandAudioInjector,
  NullAudioInjector,
  PLAYER_PREFERENCE,
  detectAudioPlayer,
} from "../src/audioInjector.js";

/** A stand-in for a spawned player process. */
class FakePlayer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  killSignal: string | null = null;
  readonly written: Buffer[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(Buffer.from(chunk)));
  }

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal ?? null;
    return true;
  }

  get bytes(): number {
    return this.written.reduce((n, c) => n + c.length, 0);
  }
}

/** Captures every spawn so a test can inspect argv and the process list. */
function fakeSpawner() {
  const spawned: Array<{ cmd: string; args: string[]; proc: FakePlayer }> = [];
  const spawnFn = (cmd: string, args: string[]): ChildProcess => {
    const proc = new FakePlayer();
    spawned.push({ cmd, args, proc });
    return proc as unknown as ChildProcess;
  };
  return { spawned, spawnFn };
}

const HAS_ALL = () => true;

test("the player is auto-detected in preference order", () => {
  assert.deepEqual([...PLAYER_PREFERENCE], ["pw-play", "paplay", "aplay"]);
  // PipeWire wins when everything is present.
  assert.equal(detectAudioPlayer(HAS_ALL), "pw-play");
  // Falls through as each is missing.
  assert.equal(
    detectAudioPlayer((b) => b !== "pw-play"),
    "paplay",
  );
  assert.equal(
    detectAudioPlayer((b) => b === "aplay"),
    "aplay",
  );
  assert.equal(
    detectAudioPlayer(() => false),
    null,
  );
});

test("no player installed is a clear error, not a mystery silence", () => {
  assert.throws(
    () => new CommandAudioInjector({ lookPath: () => false }),
    /No audio player found on PATH.*pipewire-utils/s,
  );
});

test("each player gets argv describing the raw PCM format", () => {
  const pw = new CommandAudioInjector({ player: "pw-play", sampleRate: 16000, channels: 1 });
  assert.deepEqual(pw.buildArgs(), ["--format=s16", "--rate=16000", "--channels=1", "-"]);

  const pa = new CommandAudioInjector({ player: "paplay", sampleRate: 8000, channels: 2 });
  assert.deepEqual(pa.buildArgs(), ["--raw", "--format=s16le", "--rate=8000", "--channels=2"]);

  const al = new CommandAudioInjector({ player: "aplay", sampleRate: 16000, channels: 1 });
  assert.deepEqual(al.buildArgs(), [
    "-q",
    "-f",
    "S16_LE",
    "-r",
    "16000",
    "-c",
    "1",
    "-t",
    "raw",
    "-",
  ]);
});

test("a sink targets a specific device — this is how Bluetooth HFP is selected", () => {
  const hfp = "bluez_output.AA_BB_CC_DD_EE_FF.1";
  assert.ok(
    new CommandAudioInjector({ player: "pw-play", sink: hfp })
      .buildArgs()
      .includes(`--target=${hfp}`),
  );
  assert.ok(
    new CommandAudioInjector({ player: "paplay", sink: hfp })
      .buildArgs()
      .includes(`--device=${hfp}`),
  );
});

test("PCM is piped to one long-lived player, not a process per chunk", () => {
  const { spawned, spawnFn } = fakeSpawner();
  const injector = new CommandAudioInjector({ player: "pw-play", spawnFn });

  injector.write(Buffer.alloc(320, 1));
  injector.write(Buffer.alloc(320, 2));
  injector.write(Buffer.alloc(320, 3));

  assert.equal(spawned.length, 1, "one player for the whole utterance");
  assert.equal(spawned[0]!.cmd, "pw-play");
  assert.equal(spawned[0]!.proc.bytes, 960);
  assert.equal(injector.bytesWritten, 960);
  assert.equal(injector.running, true);
});

test("barge-in kills the player so buffered audio is dropped, then restarts", () => {
  const { spawned, spawnFn } = fakeSpawner();
  const injector = new CommandAudioInjector({ player: "pw-play", spawnFn });

  injector.write(Buffer.alloc(3200));
  const first = spawned[0]!.proc;
  assert.equal(first.killed, false);

  // The caller talks over the agent.
  injector.cancel();
  assert.equal(first.killed, true);
  // SIGKILL, not SIGTERM: a graceful stop would let the player drain the very
  // audio barge-in is trying to suppress.
  assert.equal(first.killSignal, "SIGKILL");
  assert.equal(injector.running, false);
  assert.equal(injector.restartCount, 1);

  // The reply to what the caller just said starts a fresh player.
  injector.write(Buffer.alloc(320));
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1]!.proc.bytes, 320);
});

test("cancel with nothing playing is harmless", () => {
  const { spawned, spawnFn } = fakeSpawner();
  const injector = new CommandAudioInjector({ player: "pw-play", spawnFn });
  injector.cancel();
  assert.equal(spawned.length, 0);
  assert.equal(injector.restartCount, 0);
});

test("end closes stdin so the player drains, and refuses later writes", () => {
  const { spawned, spawnFn } = fakeSpawner();
  const injector = new CommandAudioInjector({ player: "pw-play", spawnFn });
  injector.write(Buffer.alloc(320));

  injector.end();
  injector.end(); // idempotent
  assert.equal(spawned[0]!.proc.killed, false, "end drains rather than kills");
  assert.throws(() => injector.write(Buffer.alloc(320)), /write after end/);
});

test("player stderr is surfaced rather than swallowed", async () => {
  const { spawned, spawnFn } = fakeSpawner();
  const errors: string[] = [];
  const injector = new CommandAudioInjector({
    player: "pw-play",
    spawnFn,
    onError: (m) => errors.push(m),
  });
  injector.write(Buffer.alloc(320));

  spawned[0]!.proc.stderr.write("Cannot connect to sink\n");
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /\[pw-play\] Cannot connect to sink/);
});

test("a player that fails to start is reported, not thrown into the call", async () => {
  const { spawned, spawnFn } = fakeSpawner();
  const errors: string[] = [];
  const injector = new CommandAudioInjector({
    player: "pw-play",
    spawnFn,
    onError: (m) => errors.push(m),
  });
  injector.write(Buffer.alloc(320));

  spawned[0]!.proc.emit("error", new Error("ENOENT"));
  await new Promise((r) => setTimeout(r, 10));

  assert.match(errors[0]!, /failed to start pw-play: ENOENT/);
  assert.equal(injector.running, false);
});

test("the null injector keeps a call running when nothing can play", () => {
  const injector = new NullAudioInjector();
  assert.equal(injector.sampleRate, 16000);
  assert.equal(injector.channels, 1);
  injector.write(Buffer.alloc(640));
  assert.equal(injector.bytesWritten, 640);
  // Both are no-ops rather than errors, so the call loop needs no special case.
  assert.doesNotThrow(() => injector.cancel());
  assert.doesNotThrow(() => injector.end());
});
