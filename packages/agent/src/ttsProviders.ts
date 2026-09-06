/**
 * Concrete `TtsClient` implementations: two hosted APIs and one local binary.
 *
 * All three return what `LocalOutStream.speak()` wants and nothing else —
 * **raw Int16 LE mono PCM**, no container. That is why the OpenAI adapter asks
 * for `response_format: "pcm"` rather than the mp3 default, why the ElevenLabs
 * adapter asks for `output_format=pcm_*`, and why `CommandTts` strips the WAV
 * header the local engines insist on writing. A container reaching the
 * injector would be played as audio and sound like a burst of static.
 *
 * Cancellation runs all the way down. Barge-in has to stop synthesis
 * *in flight*: the caller has already talked over the reply, so finishing the
 * request wastes a metered API call and risks the audio arriving late and
 * being spoken over them again. The HTTP providers hand the signal to `fetch`;
 * `CommandTts` kills the engine process. Nothing here merely discards a result
 * after the fact.
 *
 * `CommandTts` exists so the whole call loop — STT, LLM, TTS, injection — can
 * be exercised offline with no API key and no spend, which is what makes the
 * end-to-end suite runnable in CI.
 */

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { floatToPcm16, normalize, parseWavHeader } from "@neuracall/audio-pipeline";
import type { AppConfig } from "@neuracall/config";
import { DEFAULT_LLM_BASE_URL } from "./llm.js";
import { SilentTts, type SynthesizedSpeech, type TtsClient, type TtsRequest } from "./tts.js";

/** Rate the agent asks for when nothing else says otherwise (LocalOutStream's default). */
export const DEFAULT_TTS_SAMPLE_RATE = 16000;

/** Per-request deadline. A call cannot wait forever for a sentence. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Placeholder value used throughout .env.example; treated as "not set". */
const PLACEHOLDER = "replace-me";

// ------------------------------------------------------------ OpenAI-compatible

/** OpenAI's `response_format: "pcm"` is documented as 24 kHz mono Int16 LE. */
export const OPENAI_PCM_SAMPLE_RATE = 24000;

export interface OpenAiCompatibleTtsOptions {
  apiKey: string;
  /** Model identifier as the provider names it (`gpt-4o-mini-tts`, `tts-1`, ...). */
  model: string;
  /** Voice identifier. Default "alloy". */
  voice?: string;
  /** API root. Default OpenAI. */
  baseUrl?: string;
  /** Rate the synthesised PCM is delivered at, resampling if needed. Default 16000. */
  sampleRate?: number;
  /**
   * Rate the server actually returns for `response_format: "pcm"`. Only worth
   * setting for an OpenAI-compatible server that differs from the 24 kHz spec.
   */
  providerSampleRate?: number;
  /** Playback speed passed through to the API, when the provider supports it. */
  speed?: number;
  /** Extra headers (an OpenAI-compatible gateway's own auth, for instance). */
  headers?: Record<string, string>;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default 20000. */
  timeoutMs?: number;
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Speaks the OpenAI `/audio/speech` protocol. */
export class OpenAiCompatibleTts implements TtsClient {
  readonly sampleRate: number;
  private readonly opts: OpenAiCompatibleTtsOptions;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OpenAiCompatibleTtsOptions) {
    if (!opts.apiKey) throw new Error("OpenAiCompatibleTts: apiKey is required");
    if (!opts.model) throw new Error("OpenAiCompatibleTts: model is required");
    this.opts = opts;
    this.sampleRate = opts.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async synthesize(request: TtsRequest): Promise<SynthesizedSpeech> {
    const text = request.text.trim();
    if (text === "") return silence(this.sampleRate);

    const baseUrl = (this.opts.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
    const body: Record<string, unknown> = {
      model: this.opts.model,
      voice: this.opts.voice ?? "alloy",
      input: text,
      response_format: "pcm",
    };
    if (this.opts.speed !== undefined) body["speed"] = this.opts.speed;

    const audio = await postForAudio(this.fetchFn, `${baseUrl}/audio/speech`, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      label: "OpenAI TTS",
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return conform(
      audio,
      this.opts.providerSampleRate ?? OPENAI_PCM_SAMPLE_RATE,
      1,
      this.sampleRate,
    );
  }
}

// ------------------------------------------------------------------ ElevenLabs

/**
 * Rates ElevenLabs will emit as raw PCM (`output_format=pcm_<rate>`). Anything
 * else has to be resampled here, so the closest one at or above the requested
 * rate is asked for — downsampling loses nothing that was ever going to
 * survive a phone call, upsampling invents detail.
 */
export const ELEVENLABS_PCM_RATES: readonly number[] = [8000, 16000, 22050, 24000, 44100];

/** ElevenLabs' stock "Rachel" voice — a working default, not a recommendation. */
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

export interface ElevenLabsTtsOptions {
  apiKey: string;
  /** Voice id from the ElevenLabs voice library. Default "Rachel". */
  voiceId?: string;
  /** Model id. Default `eleven_turbo_v2_5` — the latency tier a live call needs. */
  model?: string;
  /** API root. Default https://api.elevenlabs.io/v1. */
  baseUrl?: string;
  /** Rate the synthesised PCM is delivered at, resampling if needed. Default 16000. */
  sampleRate?: number;
  /** Passed through as `voice_settings` when set. */
  voiceSettings?: Record<string, unknown>;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default 20000. */
  timeoutMs?: number;
}

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

/** The PCM rate to request from ElevenLabs for a given target rate. */
export function elevenLabsOutputRate(targetRate: number): number {
  const atOrAbove = ELEVENLABS_PCM_RATES.filter((r) => r >= targetRate);
  return atOrAbove[0] ?? ELEVENLABS_PCM_RATES[ELEVENLABS_PCM_RATES.length - 1]!;
}

/** Speaks the ElevenLabs `/text-to-speech/{voiceId}` protocol. */
export class ElevenLabsTts implements TtsClient {
  readonly sampleRate: number;
  readonly voiceId: string;
  /** Rate asked of the API before any local resampling. */
  readonly outputRate: number;
  private readonly opts: ElevenLabsTtsOptions;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ElevenLabsTtsOptions) {
    if (!opts.apiKey) throw new Error("ElevenLabsTts: apiKey is required");
    this.opts = opts;
    this.voiceId = opts.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
    this.sampleRate = opts.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
    this.outputRate = elevenLabsOutputRate(this.sampleRate);
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async synthesize(request: TtsRequest): Promise<SynthesizedSpeech> {
    const text = request.text.trim();
    if (text === "") return silence(this.sampleRate);

    const baseUrl = (this.opts.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, "");
    const url =
      `${baseUrl}/text-to-speech/${encodeURIComponent(this.voiceId)}` +
      `?output_format=pcm_${this.outputRate}`;
    const body: Record<string, unknown> = {
      text,
      model_id: this.opts.model ?? "eleven_turbo_v2_5",
    };
    if (this.opts.voiceSettings) body["voice_settings"] = this.opts.voiceSettings;

    const audio = await postForAudio(this.fetchFn, url, {
      headers: {
        "content-type": "application/json",
        // ElevenLabs authenticates with its own header, not Bearer.
        "xi-api-key": this.opts.apiKey,
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      label: "ElevenLabs TTS",
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return conform(audio, this.outputRate, 1, this.sampleRate);
  }
}

// --------------------------------------------------------------- local command

/** Local engines that turn text into a WAV file, in preference order. */
export type TtsCommandEngine = "espeak-ng" | "espeak" | "piper" | "pico2wave";

/**
 * espeak-ng first (maintained, best language coverage), plain espeak as its
 * older twin, piper for genuinely good neural voices when a model is
 * configured, pico2wave last — tiny, en/de/es/fr/it only, but present on many
 * minimal installs.
 */
export const TTS_COMMAND_PREFERENCE: readonly TtsCommandEngine[] = [
  "espeak-ng",
  "espeak",
  "piper",
  "pico2wave",
] as const;

/** The subset of ChildProcess `CommandTts` needs (so tests can fake it). */
export interface TtsChild {
  stdin: Writable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
}

export interface TtsSpawn {
  (cmd: string, args: string[]): TtsChild;
}

/** Real spawner: the engine binary on PATH, stdout ignored (audio goes to a file). */
export const defaultTtsSpawn: TtsSpawn = (cmd, args) =>
  spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] }) as unknown as TtsChild;

/** Real PATH probe — a directory walk rather than a `which` subprocess per candidate. */
export function defaultLookPath(binary: string): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, binary), fsConstants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** The first installed engine, or null when none is. */
export function detectTtsCommand(
  lookPath: (binary: string) => boolean = defaultLookPath,
  candidates: readonly TtsCommandEngine[] = TTS_COMMAND_PREFERENCE,
): TtsCommandEngine | null {
  return candidates.find((engine) => lookPath(engine)) ?? null;
}

export interface CommandTtsOptions {
  /** Engine binary. Auto-detected from PATH when omitted. */
  engine?: TtsCommandEngine;
  /** Voice for espeak/espeak-ng (`-v`), language for pico2wave (`-l`). */
  voice?: string;
  /** Speaking rate in words per minute (espeak family only). */
  wordsPerMinute?: number;
  /** Path to the `.onnx` voice model. Required by, and only used by, piper. */
  modelPath?: string;
  /** Rate the synthesised PCM is delivered at, resampling if needed. Default 16000. */
  sampleRate?: number;
  /** Directory the intermediate WAV is written under. Default the OS temp dir. */
  tmpDir?: string;
  /** Give up on a wedged engine after this long. Default 20000 ms. */
  timeoutMs?: number;
  /** Look up a binary on PATH. Injectable for tests. */
  lookPath?: (binary: string) => boolean;
  /** Process spawner. Injectable for tests. */
  spawnFn?: TtsSpawn;
}

/**
 * Text in, raw PCM out, using a speech engine already installed on the host.
 *
 * Every supported engine writes a WAV file rather than streaming raw samples
 * to stdout, so each utterance goes through a private temp directory
 * (`mkdtemp`, mode 0700) that is removed whether synthesis succeeded, failed
 * or was interrupted. The WAV is decoded with the audio-pipeline's parser and
 * resampled to the requested rate, because the engines disagree about theirs:
 * espeak-ng emits 22.05 kHz, pico2wave 16 kHz, piper whatever its model was
 * trained at.
 */
export class CommandTts implements TtsClient {
  readonly engine: TtsCommandEngine;
  readonly sampleRate: number;

  private readonly opts: CommandTtsOptions;
  private readonly spawnFn: TtsSpawn;
  private readonly tmpDir: string;
  private readonly timeoutMs: number;

  constructor(opts: CommandTtsOptions = {}) {
    const lookPath = opts.lookPath ?? defaultLookPath;
    const engine = opts.engine ?? detectTtsCommand(lookPath, usableEngines(opts.modelPath));
    if (!engine) {
      throw new Error(
        `No local speech engine found on PATH (tried ${TTS_COMMAND_PREFERENCE.join(", ")}). ` +
          `Install espeak-ng, or pass { engine }.`,
      );
    }
    // Reject an unsupported engine at construction. `buildArgs` switches over
    // the known four and would otherwise return undefined for anything else,
    // spawning the binary with no arguments — which produces no WAV and fails
    // every utterance, long after selection reported a healthy provider.
    if (!TTS_COMMAND_PREFERENCE.includes(engine)) {
      throw new Error(
        `CommandTts: unsupported engine ${JSON.stringify(engine)}. ` +
          `Supported: ${TTS_COMMAND_PREFERENCE.join(", ")}.`,
      );
    }
    if (engine === "piper" && !opts.modelPath) {
      throw new Error("CommandTts: piper needs { modelPath } pointing at a .onnx voice model");
    }
    this.engine = engine;
    this.opts = opts;
    this.sampleRate = opts.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
    this.spawnFn = opts.spawnFn ?? defaultTtsSpawn;
    this.tmpDir = opts.tmpDir ?? tmpdir();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Whether this engine reads its text from stdin rather than argv. */
  get textOnStdin(): boolean {
    return this.engine === "piper";
  }

  /**
   * The argv that makes this engine write `text` to `outPath` as a WAV.
   * `--` terminates option parsing so a reply starting with "-" is spoken
   * rather than parsed as a flag.
   */
  buildArgs(text: string, outPath: string): string[] {
    switch (this.engine) {
      case "espeak-ng":
      case "espeak":
        return [
          "-w",
          outPath,
          ...(this.opts.voice ? ["-v", this.opts.voice] : []),
          ...(this.opts.wordsPerMinute ? ["-s", String(this.opts.wordsPerMinute)] : []),
          "--",
          text,
        ];
      case "piper":
        // Text arrives on stdin; piper has no argv form for it.
        return ["--model", this.opts.modelPath ?? "", "--output_file", outPath];
      case "pico2wave":
        return ["-w", outPath, ...(this.opts.voice ? ["-l", this.opts.voice] : []), "--", text];
    }
  }

  async synthesize(request: TtsRequest): Promise<SynthesizedSpeech> {
    const text = request.text.trim();
    if (text === "") return silence(this.sampleRate);
    request.signal?.throwIfAborted();

    const dir = mkdtempSync(join(this.tmpDir, "neuracall-tts-"));
    const outPath = join(dir, "speech.wav");
    try {
      await this.run(text, outPath, request.signal);
      request.signal?.throwIfAborted();
      return decodeWav(readFileSync(outPath), this.sampleRate);
    } finally {
      // Synthesised speech is call content; it must not outlive the utterance.
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private run(text: string, outPath: string, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(this.engine, this.buildArgs(text, outPath));
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };

      // Barge-in: SIGKILL rather than SIGTERM — nothing this process has
      // produced so far is wanted, so there is nothing to let it finish.
      function onAbort(): void {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(toError(signal?.reason ?? new Error("aborted")));
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          finish(new Error(`${this.engine} did not finish within ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        timer.unref();
      }

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString();
      });
      child.on("error", (err: Error) =>
        finish(new Error(`failed to start ${this.engine}: ${err.message}`)),
      );
      child.on("close", (code, sig) => {
        if (code === 0) {
          finish();
          return;
        }
        const how = code === null ? `signal ${String(sig)}` : `exit code ${code}`;
        finish(
          new Error(
            `${this.engine} failed with ${how}${stderr.trim() ? ` — ${stderr.trim().slice(0, 500)}` : ""}`,
          ),
        );
      });

      const stdin = child.stdin;
      if (stdin) {
        // A killed engine makes writes fail with EPIPE; that is the abort
        // path doing its job, not a synthesis error.
        stdin.on("error", () => undefined);
        try {
          if (this.textOnStdin) stdin.write(`${text}\n`);
          stdin.end();
        } catch {
          /* the close/error handler reports what actually went wrong */
        }
      }
    });
  }
}

/** Decode a PCM WAV to mono Int16 at `targetRate`. */
export function decodeWav(wav: Uint8Array, targetRate: number): SynthesizedSpeech {
  const header = parseWavHeader(wav);
  if (header.bitsPerSample !== 16) {
    throw new Error(`CommandTts: expected 16-bit PCM, got ${header.bitsPerSample}-bit`);
  }
  if (header.channels !== 1 && header.channels !== 2) {
    throw new Error(`CommandTts: expected mono or stereo, got ${header.channels} channels`);
  }
  // The declared data size can overrun a truncated file; trust the bytes present.
  const end = Math.min(wav.length, header.dataOffset + header.dataBytes);
  const data = wav.subarray(header.dataOffset, end);
  return conform(data, header.sampleRate, header.channels, targetRate);
}

// -------------------------------------------------------------------- selection

/** Which provider `selectTtsClient` settled on, and why. */
export interface TtsSelection {
  provider: "openai" | "elevenlabs" | "command" | "silent";
  /** One line fit for a startup log. Never contains the API key. */
  description: string;
  client: TtsClient;
}

export interface TtsSelectionOptions {
  /** Rate the agent wants PCM at. Default 16000. */
  sampleRate?: number;
  /** Environment holding the provider hints. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Look up a binary on PATH. Injectable for tests. */
  lookPath?: (binary: string) => boolean;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Injectable for tests. */
  spawnFn?: TtsSpawn;
}

/**
 * Pick the best TTS the configuration and this machine can support.
 *
 * Order: an explicit `TTS_PROVIDER`, else a hosted provider if `TTS_API_KEY`
 * is set (ElevenLabs when the model id looks like one of theirs, otherwise the
 * OpenAI-compatible path), else the OpenAI-compatible endpoint the agent's LLM
 * already talks to (`LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`) so a reply is
 * audible without any TTS-specific setup, else a local engine, else silence.
 *
 * It never throws. A call must be answerable even when TTS is unconfigured or
 * broken: `SilentTts` still transcribes the caller, still runs the agent and
 * still logs the reply — the far end simply hears nothing, which beats not
 * picking up. Only a wholly unconfigured TTS section borrows the LLM endpoint;
 * an operator who set a `TTS_*` key or model is never silently redirected.
 */
export function selectTtsClient(
  config: Pick<AppConfig, "tts"> & Partial<Pick<AppConfig, "llm">>,
  opts: TtsSelectionOptions = {},
): TtsSelection {
  const env = opts.env ?? process.env;
  const sampleRate =
    opts.sampleRate ?? numberFromEnv(env, "TTS_SAMPLE_RATE") ?? DEFAULT_TTS_SAMPLE_RATE;
  const apiKey = clean(config.tts.apiKey);
  const model = clean(config.tts.model);
  const requested = clean(env["TTS_PROVIDER"])?.toLowerCase();

  // The OpenAI-compatible endpoint the agent already talks to can back the
  // default voice. Both halves of it must be set — a key without a model (or
  // vice versa) means an unfinished setup, not a provider.
  const llmApiKey = clean(config.llm?.apiKey);
  const llmModel = clean(config.llm?.model);
  const llmBacksTts = llmApiKey !== undefined && llmModel !== undefined;

  const wanted: TtsSelection["provider"][] =
    requested === "openai" ||
    requested === "elevenlabs" ||
    requested === "command" ||
    requested === "silent"
      ? [requested]
      : apiKey
        ? [looksLikeElevenLabs(model) ? "elevenlabs" : "openai", "command"]
        : llmBacksTts
          ? ["openai", "command"]
          : ["command"];

  for (const provider of wanted) {
    const selection = tryBuild(provider, {
      config,
      env,
      sampleRate,
      apiKey,
      model,
      llmApiKey,
      llmModel,
      opts,
    });
    if (selection) return selection;
  }

  return {
    provider: "silent",
    description:
      requested === "silent"
        ? "silent (TTS_PROVIDER=silent) — the caller hears nothing"
        : "silent (no TTS provider configured and no local engine found) — the caller hears nothing",
    client: new SilentTts({ sampleRate }),
  };
}

/** `selectTtsClient` without the diagnostics, for callers that only want the client. */
export function createTtsClient(
  config: Pick<AppConfig, "tts">,
  opts: TtsSelectionOptions = {},
): TtsClient {
  return selectTtsClient(config, opts).client;
}

interface BuildContext {
  config: Pick<AppConfig, "tts"> & Partial<Pick<AppConfig, "llm">>;
  env: NodeJS.ProcessEnv;
  sampleRate: number;
  apiKey: string | undefined;
  model: string | undefined;
  llmApiKey: string | undefined;
  llmModel: string | undefined;
  opts: TtsSelectionOptions;
}

/** Narrow a raw env value to a supported engine, or undefined if it is not one. */
function asCommandEngine(value: string | undefined): TtsCommandEngine | undefined {
  if (value === undefined) return undefined;
  return TTS_COMMAND_PREFERENCE.includes(value as TtsCommandEngine)
    ? (value as TtsCommandEngine)
    : undefined;
}

/** Construct one provider, or null when this machine/config cannot support it. */
function tryBuild(provider: TtsSelection["provider"], ctx: BuildContext): TtsSelection | null {
  const { env, sampleRate, apiKey, model, llmApiKey, llmModel, opts } = ctx;
  const ttsBaseUrl = clean(env["TTS_BASE_URL"]);
  const voice = clean(env["TTS_VOICE"]);
  try {
    switch (provider) {
      case "openai": {
        // A TTS-specific key or model owns this selection exactly as before
        // (both are required, or the provider is unusable and the next
        // candidate — ultimately the local engine — gets its turn). Only a
        // wholly unconfigured TTS section borrows the LLM endpoint the agent
        // already talks to, so the default is real speech whenever an
        // OpenAI-compatible LLM is set up.
        const ttsOwned = apiKey !== undefined || model !== undefined;
        const key = ttsOwned ? apiKey : llmApiKey;
        const ttsModel = ttsOwned ? model : llmModel;
        if (!key || !ttsModel) return null;
        // The borrowed endpoint travels through the LLM's base URL — including
        // its OpenRouter default — so no TTS-specific base needs configuring;
        // an explicit TTS_BASE_URL still wins for either source.
        const baseUrl = ttsOwned
          ? ttsBaseUrl
          : clean(env["LLM_BASE_URL"]) ?? ttsBaseUrl ?? DEFAULT_LLM_BASE_URL;
        return {
          provider,
          description: ttsOwned
            ? `OpenAI-compatible TTS (${ttsModel}, voice ${voice ?? "alloy"}) at ${sampleRate} Hz`
            : `OpenAI-compatible TTS from the LLM config (${ttsModel}, voice ${voice ?? "alloy"}) at ${sampleRate} Hz`,
          client: new OpenAiCompatibleTts({
            apiKey: key,
            model: ttsModel,
            sampleRate,
            ...(voice ? { voice } : {}),
            ...(baseUrl ? { baseUrl } : {}),
            ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
          }),
        };
      }
      case "elevenlabs": {
        if (!apiKey) return null;
        const client = new ElevenLabsTts({
          apiKey,
          sampleRate,
          ...(model ? { model } : {}),
          ...(voice ? { voiceId: voice } : {}),
          ...(ttsBaseUrl ? { baseUrl: ttsBaseUrl } : {}),
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        });
        return {
          provider,
          description: `ElevenLabs TTS (voice ${client.voiceId}) at ${client.outputRate} Hz`,
          client,
        };
      }
      case "command": {
        const modelPath = clean(env["PIPER_MODEL"]);
        // An unrecognised engine name must not be accepted: it would be spawned
        // with no arguments, produce no WAV, and fail every single utterance of
        // a live call — after selection had already reported success. Rejecting
        // it here lets the caller fall through to SilentTts, which at least
        // keeps the call answerable.
        const engine = asCommandEngine(clean(env["TTS_COMMAND"]));
        // TTS_VOICE means different things per provider (an OpenAI voice name,
        // an ElevenLabs voice id, an espeak language code). Only a voice chosen
        // *for the local engine* is safe to pass here, or a hosted voice left
        // in the environment would be handed to espeak as a language.
        const commandVoice = clean(env["TTS_COMMAND_VOICE"]);
        const client = new CommandTts({
          sampleRate,
          ...(engine ? { engine } : {}),
          ...(modelPath ? { modelPath } : {}),
          ...(commandVoice ? { voice: commandVoice } : {}),
          ...(opts.lookPath ? { lookPath: opts.lookPath } : {}),
          ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
        });
        return {
          provider,
          description: `local ${client.engine} at ${sampleRate} Hz`,
          client,
        };
      }
      case "silent":
        return null; // the caller's own fallback covers it
    }
  } catch {
    // An unusable provider is not fatal; the next candidate (ultimately
    // SilentTts) gets its turn rather than the call failing to be answered.
    return null;
  }
}

/** ElevenLabs model ids are all `eleven_*`; nothing else uses that prefix. */
function looksLikeElevenLabs(model: string | undefined): boolean {
  return model !== undefined && model.toLowerCase().startsWith("eleven");
}

/** piper cannot run without a voice model, so it is not a detection candidate without one. */
function usableEngines(modelPath: string | undefined): readonly TtsCommandEngine[] {
  return modelPath ? TTS_COMMAND_PREFERENCE : TTS_COMMAND_PREFERENCE.filter((e) => e !== "piper");
}

// ---------------------------------------------------------------------- helpers

interface PostForAudioInit {
  headers: Record<string, string>;
  body: string;
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** POST JSON, expect audio bytes back, and let the caller's signal win. */
async function postForAudio(
  fetchFn: typeof fetch,
  url: string,
  init: PostForAudioInit,
): Promise<Uint8Array> {
  // A slow provider must not hold a live call open indefinitely, but a caller
  // interrupting must still win — so combine the deadline with the caller's
  // own signal rather than replacing it.
  const timeout = AbortSignal.timeout(init.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  const response = await fetchFn(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${init.label} request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ""}`,
    );
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  // The response body can arrive in full while the caller is interrupting; a
  // reply they have already talked over must not be spoken anyway.
  init.signal?.throwIfAborted();
  return audio;
}

/** Mono Int16 at `targetRate`, converting only when the source format differs. */
function conform(
  pcm: Uint8Array,
  sourceRate: number,
  sourceChannels: 1 | 2,
  targetRate: number,
): SynthesizedSpeech {
  const frameBytes = 2 * sourceChannels;
  // A partial frame is not audio, and would shift every later sample's channel.
  const usable = pcm.subarray(0, pcm.length - (pcm.length % frameBytes));
  if (sourceRate === targetRate && sourceChannels === 1) {
    return { pcm: usable, sampleRate: targetRate, channels: 1 };
  }
  const buf = Buffer.from(usable.buffer, usable.byteOffset, usable.byteLength);
  const mono = normalize(buf, sourceChannels, sourceRate, targetRate);
  return { pcm: floatToPcm16([mono]), sampleRate: targetRate, channels: 1 };
}

function silence(sampleRate: number): SynthesizedSpeech {
  return { pcm: new Uint8Array(0), sampleRate, channels: 1 };
}

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes(PLACEHOLDER)) return undefined;
  return trimmed;
}

function numberFromEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = clean(env[name]);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
