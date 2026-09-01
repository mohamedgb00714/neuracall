import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ScrcpyBridge, type ScrcpyChild, type ScrcpySpawn } from "../src/bridge.js";
import { wavHeader, type WavFormat } from "../src/wavStream.js";

const FMT = { channels: 2, sampleRate: 48000, bitsPerSample: 16 };
const POSIX = process.platform !== "win32";

/** Minimal fake scrcpy child process for tests. */
class FakeChild extends EventEmitter implements ScrcpyChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdio: ReadonlyArray<PassThrough | null>;
  killed = false;
  pid = 9999;
  constructor() {
    super();
    this.stdio = [null, this.stdout, this.stderr];
  }
  kill(signal?: NodeJS.Signals) {
    this.killed = true;
    this.emit("close", null, signal ?? "SIGTERM");
    return true;
  }
}

function tmp(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "neuracall-bridge-")), name);
}

function makeBridge(
  fake: FakeChild,
  extra: Partial<ConstructorParameters<typeof ScrcpyBridge>[0]> = {},
) {
  const pushed: Uint8Array[] = [];
  let format: WavFormat | null = null;
  let ended = 0;
  let spawnedArgs: string[] = [];
  let spawnedStdio: unknown = null;
  const spawn: ScrcpySpawn = (args, opts) => {
    spawnedArgs = args;
    spawnedStdio = opts.stdio;
    return fake;
  };
  const bridge = new ScrcpyBridge({
    spawn,
    endpoint: "s1",
    platform: "linux",
    // default every test to an isolated temp file unless it opts into a FIFO
    transport: "file",
    recordPath: tmp("cap.wav"),
    tailIntervalMs: 10,
    sink: {
      format: (f) => (format = f),
      push: (b) => pushed.push(b),
      end: () => ended++,
    },
    ...extra,
  });
  bridge.on("error", () => {}); // never let a stray error event throw in tests
  return {
    bridge,
    pushed,
    pcm: () => [...Buffer.concat(pushed.map((u) => Buffer.from(u)))],
    get format() {
      return format;
    },
    get ended() {
      return ended;
    },
    get spawnedArgs() {
      return spawnedArgs;
    },
    get spawnedStdio() {
      return spawnedStdio;
    },
  };
}

test("buildArgs emits a verified audio-only scrcpy invocation recording WAV", () => {
  const { bridge } = makeBridge(new FakeChild(), {
    endpoint: "192.168.0.10:5555",
    audioSource: "mic",
  });
  assert.deepEqual(bridge.buildArgs("/tmp/x.fifo"), [
    "-s",
    "192.168.0.10:5555",
    "--no-video",
    "--no-window",
    "--no-playback",
    "--audio-source",
    "mic",
    "--audio-codec",
    "raw",
    "--record-format",
    "wav",
    "--record",
    "/tmp/x.fifo",
  ]);
  // it must NOT use flags scrcpy 3.x does not have
  assert.ok(!bridge.buildArgs("x").includes("--audio-output"));
});

test("stderr ERROR/WARN lines become 'error', other output becomes 'log'", async () => {
  const fake = new FakeChild();
  const h = makeBridge(fake);
  const errors: string[] = [];
  const logs: string[] = [];
  h.bridge.on("error", (m) => errors.push(m));
  h.bridge.on("log", (m) => logs.push(m));
  h.bridge.start();
  fake.stderr.write(
    "INFO: No video mirroring, SDK mouse disabled\nWARN: Audio capture: something\n",
  );
  fake.stdout.write("scrcpy 3.3.4 <https://github.com/Genymobile/scrcpy>\n[server] ERROR: boom\n");
  await sleep(5);
  assert.deepEqual(errors, ["WARN: Audio capture: something", "[server] ERROR: boom"]);
  assert.deepEqual(logs, [
    "INFO: No video mirroring, SDK mouse disabled",
    "scrcpy 3.3.4 <https://github.com/Genymobile/scrcpy>",
  ]);
  fake.emit("close", 0, null);
});

test("bridge emits exit with the code and ends the sink when scrcpy closes", async () => {
  const fake = new FakeChild();
  const h = makeBridge(fake);
  h.bridge.start();
  const exited = once(h.bridge, "exit");
  fake.emit("close", 0, null);
  const [exit] = await exited;
  assert.deepEqual(exit, { endpoint: "s1", code: 0, signal: null });
  assert.equal(h.bridge.running, false);
  assert.equal(h.ended, 1);
});

test("bridge refuses to start twice", () => {
  const fake = new FakeChild();
  const { bridge } = makeBridge(fake);
  bridge.start();
  assert.throws(() => bridge.start(), /already running/);
  fake.emit("close", 0, null);
});

test("stop terminates the scrcpy process with SIGTERM", () => {
  const fake = new FakeChild();
  const { bridge } = makeBridge(fake);
  bridge.start();
  assert.ok(bridge.running);
  bridge.stop();
  assert.equal(fake.killed, true);
  assert.equal(bridge.running, false);
});

test("file transport: tails the growing .wav, reports format, then deletes it on exit", async () => {
  const recordPath = tmp("cap.wav");
  const fake = new FakeChild();
  const h = makeBridge(fake, { recordPath });
  const formats: WavFormat[] = [];
  h.bridge.on("format", (f) => formats.push(f));
  h.bridge.start();
  assert.equal(h.bridge.activeTransport, "file");
  assert.equal(h.spawnedArgs.at(-1), recordPath);
  assert.deepEqual(h.spawnedStdio, ["ignore", "pipe", "pipe"]);

  // scrcpy "writes" the file a little after starting
  await sleep(15);
  writeFileSync(recordPath, Buffer.concat([wavHeader(FMT), Buffer.from([1, 2])]));
  await sleep(40);
  appendFileSync(recordPath, Buffer.from([3, 4]));
  await sleep(40);
  assert.deepEqual(h.pcm(), [1, 2, 3, 4]);
  assert.equal(formats.length, 1);
  assert.equal(h.format?.sampleRate, 48000);

  // bytes written right before exit are still drained
  appendFileSync(recordPath, Buffer.from([5]));
  const exited = once(h.bridge, "exit");
  fake.emit("close", 0, null);
  await exited;
  assert.deepEqual(h.pcm(), [1, 2, 3, 4, 5]);
  assert.equal(existsSync(recordPath), false);
  assert.equal(h.ended, 1);
});

test("a non-WAV audio stream raises 'error' and stops scrcpy", async () => {
  const recordPath = tmp("bad.wav");
  const fake = new FakeChild();
  const h = makeBridge(fake, { recordPath });
  const errors: string[] = [];
  h.bridge.on("error", (m) => errors.push(m));
  h.bridge.start();
  const bad = Buffer.alloc(20);
  bad.write("RIFF", 0, "ascii");
  bad.write("WAVE", 8, "ascii");
  bad.write("data", 12, "ascii");
  await sleep(15);
  writeFileSync(recordPath, bad);
  await sleep(40);
  assert.match(errors[0]!, /not WAV/);
  assert.equal(fake.killed, true);
});

test("win32 defaults to the file transport", () => {
  const fake = new FakeChild();
  const h = makeBridge(fake, { platform: "win32", transport: undefined, recordPath: tmp("w.wav") });
  h.bridge.start();
  assert.equal(h.bridge.activeTransport, "file");
  assert.ok(h.bridge.target!.endsWith("w.wav"));
  fake.emit("close", 0, null);
});

test(
  "fifo transport: creates a FIFO, streams PCM written to it, cleans up on exit",
  { skip: !POSIX },
  async () => {
    const recordPath = tmp("cap.fifo");
    const fake = new FakeChild();
    const h = makeBridge(fake, { transport: "fifo", recordPath });
    const formats: WavFormat[] = [];
    h.bridge.on("format", (f) => formats.push(f));
    h.bridge.start();
    assert.equal(h.bridge.activeTransport, "fifo");
    assert.equal(h.bridge.target, recordPath);
    assert.equal(h.spawnedArgs.at(-1), recordPath);
    assert.ok(statSync(recordPath).isFIFO(), "record path must be a FIFO");

    // behave like scrcpy: open the FIFO for writing (does not block — the bridge
    // holds a reader), write the WAV stream in pieces, close.
    const wfd = openSync(recordPath, "w");
    writeSync(wfd, Buffer.concat([wavHeader(FMT), Buffer.from([1, 2, 3])]));
    await sleep(30);
    writeSync(wfd, Buffer.from([4, 5]));
    await sleep(30);
    assert.deepEqual(h.pcm(), [1, 2, 3, 4, 5]);
    assert.equal(formats.length, 1);
    assert.equal(h.format?.channels, 2);

    // bytes written right before the process exits must still be delivered
    writeSync(wfd, Buffer.from([6]));
    closeSync(wfd);
    const exited = once(h.bridge, "exit");
    fake.emit("close", 0, null);
    const [exit] = await exited;
    assert.deepEqual(exit, { endpoint: "s1", code: 0, signal: null });
    assert.deepEqual(h.pcm(), [1, 2, 3, 4, 5, 6]);
    assert.equal(existsSync(recordPath), false, "FIFO is removed");
    assert.equal(h.ended, 1);
  },
);

test(
  "fifo transport: exit with no data at all still finishes promptly",
  { skip: !POSIX },
  async () => {
    const fake = new FakeChild();
    const h = makeBridge(fake, { transport: "fifo", recordPath: tmp("empty.fifo") });
    h.bridge.start();
    const t0 = Date.now();
    const exited = once(h.bridge, "exit");
    fake.emit("close", 1, null);
    await exited;
    assert.ok(Date.now() - t0 < 500);
    assert.equal(h.pcm().length, 0);
    assert.equal(h.ended, 1);
  },
);
