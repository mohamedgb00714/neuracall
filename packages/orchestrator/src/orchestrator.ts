/**
 * The orchestrator: owns the lifecycle of every call.
 *
 * One call is: pick up an inbound ring on a device, answer it, open an
 * AssemblyAI realtime session, pump the far end's audio into it, hand each
 * finalized turn to the agent, play the agent's reply back into the call, and
 * then take everything down again — device released, session terminated,
 * record persisted.
 *
 * The single most important property here is that **teardown always runs and
 * always sends Terminate**. An AssemblyAI session that is dropped without
 * Terminate stays open and billable until the 3-hour cap, so every exit path —
 * a normal hangup, an agent error, a WebSocket drop, a phone that never
 * answers — funnels through `teardown()`, and each of its steps is guarded
 * individually so that one failure cannot skip the steps after it.
 *
 * Everything external is behind an interface (see types.ts), so the whole loop
 * runs in tests against fakes: no phone, no WebSocket, no bill.
 */

import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import {
  CallAudioSession,
  CallRecorder,
  tee,
  type AudioInjector,
  type CallAudioChunk,
} from "@neuracall/audio-pipeline";
import type {
  RealtimeParams,
  TurnEvent,
  UpdateConfigurationFields,
} from "@neuracall/aai-client";
import type {
  CallChannelDetector,
  CallController,
  CallState as TelephonyState,
  ChannelKind,
  Device,
  DevicePhase,
} from "@neuracall/device-manager";
import { CallStateMachine, type CallState } from "./stateMachine.js";
import type {
  AgentReply,
  AudioCapture,
  CallAgent,
  CallOutcome,
  CallRecord,
  CallRecordStore,
  CaptureHandle,
  TranscriptEntry,
} from "./types.js";

/** The slice of DeviceManager the orchestrator uses. */
export interface DevicePool {
  get(id: string): Device | undefined;
  setPhase(id: string, phase: DevicePhase): void;
  reportIncomingCall(id: string, channel: ChannelKind): Device | undefined;
  readonly snapshot: Device[];
}

/**
 * The slice of a RealtimeStream the orchestrator uses. The `on` overloads are
 * narrow on purpose — a plain `EventEmitter` satisfies them, while the
 * orchestrator still gets a typed `TurnEvent` instead of `any`.
 */
export interface SttStream {
  sendAudio(chunk: Uint8Array): boolean;
  /** Full realtime delta; an implementation ignores the fields it has no equivalent for. */
  updateConfiguration(update: Partial<UpdateConfigurationFields>): void;
  on(event: "turn", listener: (turn: TurnEvent) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/** The slice of RealtimeSessionManager the orchestrator uses. */
export interface SttSessionManager {
  open(
    key: { deviceId: string; channelId: string },
    opts: { params: RealtimeParams },
  ): Promise<SttStream>;
  close(key: { deviceId: string; channelId: string }, reason?: string): Promise<void>;
  /** True when a session is already open for this key (pre-flight duplicate check). */
  isOpen?(key: { deviceId: string; channelId: string }): boolean;
}

export interface OrchestratorOptions {
  devices: DevicePool;
  /** Call control for a device (answer / hang up / call state). */
  controllerFor: (deviceId: string) => CallController;
  /** Tells cellular from WhatsApp, and whether anything is ringing. */
  detector: CallChannelDetector;
  /** Opens and closes realtime STT sessions. */
  sessions: SttSessionManager;
  /** Starts far-end audio capture. */
  capture: AudioCapture;
  /**
   * Builds the transport that plays the agent's voice onto the call. Omit and
   * the call still runs end to end — transcribed, recorded, replies in the
   * transcript — but the far end hears nothing. See `CommandAudioInjector` and
   * docs/AUDIO-ABI.md.
   */
  injectorFor?: (deviceId: string, channelId: ChannelKind) => AudioInjector;
  /**
   * Answer a VoIP call by tapping its in-app accept button.
   *
   * Required for WhatsApp and friends: they do not respond to the cellular
   * KEYCODE_CALL the call controller sends. Omit it and those channels fall
   * back to the keyevent, which rings out — the orchestrator says so on the
   * "error" channel rather than failing silently.
   */
  answerVoip?: (deviceId: string, channelId: ChannelKind) => Promise<void>;
  /** The conversational brain. */
  agent: CallAgent;
  /** Where call records go. */
  store: CallRecordStore;

  /** Realtime speech model. Default "universal-3-5-pro". */
  speechModel?: string;
  /** Extra realtime params merged into every session. */
  realtimeParams?: Partial<RealtimeParams>;
  /** Rate fed to STT. Default 16000. */
  sampleRate?: number;
  /** Record call audio under this directory. Omit to not record. */
  recordingsDir?: string;
  /**
   * Forward silent audio to STT as well as speech. Default true, and changing
   * it is almost always wrong for a live call.
   *
   * AssemblyAI detects the end of a turn from how much *silence* it has
   * received (`min_turn_silence` / `max_turn_silence`). VAD-gating the pauses
   * out compresses the audio timeline into one unbroken utterance, so turns
   * never finalize, `end_of_turn` never fires, and the agent never gets a turn
   * to answer — the call goes quiet while transcription looks like it is
   * working. Set this false only for a listen-only pipeline that does not rely
   * on server-side endpointing.
   */
  emitSilence?: boolean;
  /** How often to poll the pool for inbound calls while `watch()` runs. Default 1000 ms. */
  watchIntervalMs?: number;
  /**
   * How often to check whether the far end hung up, in ms. Default 2000.
   * 0 disables polling — the call then ends only on an agent hangUp, an error
   * or an explicit `endCall()`.
   */
  hangupPollMs?: number;
  /**
   * How a live call's connectedness is probed for the hang-up watch.
   *
   * Defaults to the call controller's `callState()` — the *cellular*
   * telephony registry — which is wrong for a VoIP channel: a WhatsApp call
   * never touches it, so it reads "idle" while the call is actually up (the
   * watch would end the call seconds after it was answered) or misses the
   * hang-up entirely. Pass the channel-aware detector here for non-cellular
   * channels ("present" while the call is up, "idle" once it goes away) and
   * the watch ends the call when the channel really ends.
   */
  hangupState?: (deviceId: string, channelId: ChannelKind) => Promise<TelephonyState>;
  /**
   * Force the call down when it ends.
   *
   * Defaults to the call controller's `safeHangUp()` (KEYCODE_ENDCALL), which
   * VoIP apps ignore the same way they ignore KEYCODE_CALL on a ringing
   * screen. Pass a channel-aware hook (tap the in-app hang-up button for
   * non-cellular channels) so the phone really leaves the call.
   */
  endChannelCall?: (deviceId: string, channelId: ChannelKind) => Promise<void>;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Generates call ids. Injectable so tests get stable names. */
  makeCallId?: (deviceId: string) => string;
}

/** A call currently in flight. */
interface ActiveCall {
  record: CallRecord;
  machine: CallStateMachine;
  controller: CallController;
  session: CallAudioSession | null;
  stream: SttStream | null;
  capture: CaptureHandle | null;
  recorder: CallRecorder | null;
  /** Serialises turn handling so two replies never overlap. */
  work: Promise<void>;
  /** Resolves when the call should be torn down. */
  finished: Promise<void>;
  finish: () => void;
  hangupTimer: NodeJS.Timeout | null;
  endReason: string | null;
  outcome: CallOutcome | null;
  tornDown: boolean;
}

/**
 * Drives calls end to end.
 *
 * Events:
 *  - "call"       (record)                a call was created or updated
 *  - "state"      (callId, state, reason) a state transition
 *  - "transcript" (callId, entry)         a transcript line was added
 *  - "bargeIn"    (callId)                the caller talked over the agent
 *  - "error"      (err, callId?)          a non-fatal failure
 */
export class Orchestrator extends EventEmitter {
  private readonly opts: OrchestratorOptions;
  private readonly now: () => number;
  private readonly calls = new Map<string, ActiveCall>();
  private watchTimer: NodeJS.Timeout | null = null;
  private watching = false;
  private seq = 0;

  constructor(opts: OrchestratorOptions) {
    super();
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Calls currently in flight. */
  get activeCalls(): CallRecord[] {
    return [...this.calls.values()].map((c) => snapshot(c.record));
  }

  /** The state of a live call, or undefined once it has ended. */
  callState(callId: string): CallState | undefined {
    return this.calls.get(callId)?.machine.state;
  }

  /**
   * The first device that is online and not already busy. Returns null when
   * the pool is fully occupied, which is the signal to let the phone keep
   * ringing rather than answer a call we cannot service.
   */
  acquireDevice(): Device | null {
    return (
      this.opts.devices.snapshot.find((d) => d.adbState === "device" && d.phase === "online") ??
      null
    );
  }

  /** Begin polling the device pool for inbound calls. */
  start(): void {
    if (this.watchTimer) return;
    const interval = this.opts.watchIntervalMs ?? 1000;
    this.watching = true;
    this.watchTimer = setInterval(() => void this.poll(), interval);
    this.watchTimer.unref?.();
  }

  /** Stop polling. Calls already in flight keep running. */
  stop(): void {
    this.watching = false;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /** One pass over the pool, answering anything that is ringing. */
  async poll(): Promise<void> {
    for (const device of this.opts.devices.snapshot) {
      if (device.adbState !== "device") continue;
      if (device.phase !== "online" && device.phase !== "incoming") continue;
      if (this.hasCallOn(device.id)) continue;
      try {
        const detected = await this.opts.detector.detect(device.id);
        if (detected.present && detected.channel) {
          // Fire-and-forget, but never swallow a rejection: an overlapping
          // poll() tick can detect the same device a second time, and
          // handleIncomingCall throws for a device already on a call. An
          // unhandled rejection would take the whole process down.
          this.handleIncomingCall(device.id, detected.channel).catch((err: unknown) => {
            this.emit("error", toError(err), device.id);
          });
        }
      } catch (err) {
        this.emit("error", toError(err));
      }
    }
  }

  private hasCallOn(deviceId: string): boolean {
    for (const call of this.calls.values()) {
      if (call.record.deviceId === deviceId) return true;
    }
    return false;
  }

  /**
   * Run one inbound call to completion. Resolves with the persisted record
   * once the call has ended and everything has been torn down.
   */
  async handleIncomingCall(deviceId: string, channel: ChannelKind): Promise<CallRecord> {
    if (this.hasCallOn(deviceId)) {
      throw new Error(`Device ${deviceId} is already on a call.`);
    }

    const callId = this.opts.makeCallId?.(deviceId) ?? this.newCallId(deviceId);
    const startedAt = this.now();
    const machine = new CallStateMachine({ now: this.now });
    const record: CallRecord = {
      callId,
      deviceId,
      channelId: channel,
      direction: "inbound",
      state: machine.state,
      outcome: null,
      remoteParty: null,
      startedAt,
      answeredAt: null,
      endedAt: null,
      transcript: [],
      audioPath: null,
      states: [{ state: machine.state, at: startedAt }],
    };

    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const active: ActiveCall = {
      record,
      machine,
      controller: this.opts.controllerFor(deviceId),
      session: null,
      stream: null,
      capture: null,
      recorder: null,
      work: Promise.resolve(),
      finished,
      finish,
      hangupTimer: null,
      endReason: null,
      outcome: null,
      tornDown: false,
    };
    this.calls.set(callId, active);

    machine.on("transition", (t: { to: CallState; reason?: string }) => {
      record.state = t.to;
      record.states.push({
        state: t.to,
        at: this.now(),
        ...(t.reason ? { reason: t.reason } : {}),
      });
      this.emit("state", callId, t.to, t.reason);
    });

    try {
      await this.runCall(active, channel);
    } catch (err) {
      const error = toError(err);
      record.error = error.message;
      active.outcome ??= machine.state === "incoming" ? "missed" : "failed";
      active.endReason ??= error.message;
      this.emit("error", error, callId);
    } finally {
      await this.teardown(active);
      this.calls.delete(callId);
    }

    return snapshot(record);
  }

  /**
   * Answer the call the way this channel is actually answered.
   *
   * `KEYCODE_CALL` is the *cellular* gesture. WhatsApp, Telegram, Signal and
   * every other VoIP app ignore it completely — their accept control is a
   * button in the app's own UI. For a long time this method did not exist and
   * every channel got the keyevent, so a WhatsApp call was "answered" by
   * pressing a key nothing was listening to: the phone rang out, the caller got
   * voicemail, and nothing anywhere reported a failure. It was found only by
   * looking at a handset and seeing four missed calls.
   *
   * `answerVoip` is optional so an embedder without UI automation still gets
   * the old behaviour rather than a crash — but on those channels it will not
   * work, which is why the fallback says so.
   */
  private async answer(active: ActiveCall, channel: ChannelKind): Promise<void> {
    if (channel === "cellular" || !this.opts.answerVoip) {
      if (channel !== "cellular") {
        this.emit(
          "error",
          `answering a ${channel} call with the cellular keyevent, which VoIP apps ignore — ` +
            "wire OrchestratorOptions.answerVoip to tap the in-app accept button",
          active.record.callId,
        );
      }
      await active.controller.answer();
      return;
    }
    await this.opts.answerVoip(active.record.deviceId, channel);
  }

  /** The happy path. Anything thrown here lands in the caller's catch. */
  private async runCall(active: ActiveCall, channel: ChannelKind): Promise<void> {
    const { record, machine } = active;

    machine.to("incoming", `inbound ${channel} call detected`);
    this.opts.devices.reportIncomingCall(record.deviceId, channel);
    await this.persist(active);

    // Pre-flight the STT session key before answering. If that key is already
    // held — a manual Listen session on this device/channel — answering and
    // then opening would collide ("Session already open") and tear the call
    // back down: the caller would hear answer-then-drop. Ring out instead.
    if (this.opts.sessions.isOpen?.({ deviceId: record.deviceId, channelId: channel })) {
      throw new Error(
        `session key already held for ${record.deviceId}/${channel}; ringing out instead of answering`,
      );
    }

    await this.answer(active, channel);
    record.answeredAt = this.now();
    machine.to("answered", "answered");
    this.opts.devices.setPhase(record.deviceId, "in-call");
    await this.persist(active);

    // Open STT before capture, so no far-end audio is produced with nowhere
    // to go. A failure here aborts the call rather than leaving a phone
    // answered into silence.
    const stream = await this.opts.sessions.open(
      { deviceId: record.deviceId, channelId: channel },
      { params: this.realtimeParams() },
    );
    active.stream = stream;
    this.wireStream(active, stream);

    active.session = this.buildAudioSession(active);
    active.capture = await this.opts.capture.start({
      deviceId: record.deviceId,
      sink: active.session.remoteIn,
    });

    await this.greet(active);
    this.startHangupWatch(active);

    await active.finished;
  }

  private realtimeParams(): RealtimeParams {
    return {
      sampleRate: this.opts.sampleRate ?? 16000,
      speechModel: this.opts.speechModel ?? "universal-3-5-pro",
      ...this.opts.realtimeParams,
    };
  }

  /**
   * Build the call's audio session. Far-end chunks fan out to STT and, when
   * recording is on, to a WAV writer — through a tee whose error handler drops
   * the failing branch rather than killing the call: a recording that cannot
   * be written is not a reason to hang up on a caller.
   */
  private buildAudioSession(active: ActiveCall): CallAudioSession {
    const { record } = active;
    const sampleRate = this.opts.sampleRate ?? 16000;
    const targets: Writable[] = [this.sttSink(active)];

    if (this.opts.recordingsDir) {
      try {
        const recorder = new CallRecorder({
          baseDir: this.opts.recordingsDir,
          deviceId: record.deviceId,
          callId: record.callId,
          channelId: record.channelId,
          sampleRate,
          metadata: { direction: record.direction, remoteParty: record.remoteParty },
        });
        active.recorder = recorder;
        record.audioPath = recorder.wavPath;
        targets.push(recorder.createWritable({ closeOnFinish: false }));
      } catch (err) {
        this.emit("error", toError(err), record.callId);
      }
    }

    const sink = tee(targets, {
      onTargetError: (err, target, t) => {
        t.remove(target);
        this.emit("error", err, record.callId);
      },
    });

    // A transport that cannot start (no audio player, a missing sink) must not
    // stop the call: transcription and the record are still worth having.
    let injector: AudioInjector | undefined;
    try {
      injector = this.opts.injectorFor?.(record.deviceId, record.channelId);
    } catch (err) {
      this.emit("error", toError(err), record.callId);
    }

    return new CallAudioSession({
      deviceId: record.deviceId,
      callId: record.callId,
      channelId: record.channelId,
      sink,
      // Silence has to reach the server or turn endpointing never fires — see
      // `emitSilence` on the options.
      remoteIn: { targetSampleRate: sampleRate, emitSilence: this.opts.emitSilence ?? true },
      localOut: {
        defaultSampleRate: sampleRate,
        ...(injector ? { injector } : {}),
      },
    });
  }

  /** Pumps far-end PCM into the realtime session. */
  private sttSink(active: ActiveCall): Writable {
    return new Writable({
      objectMode: true,
      write: (chunk: CallAudioChunk, _enc, cb) => {
        this.markTalking(active, "far-end audio");
        try {
          active.stream?.sendAudio(chunk.pcm);
        } catch (err) {
          // A dead socket must not destroy the audio graph; the session's own
          // close handling ends the call.
          this.emit("error", toError(err), active.record.callId);
        }
        cb();
      },
    });
  }

  private wireStream(active: ActiveCall, stream: SttStream): void {
    // Turns are chained rather than handled concurrently, so two replies can
    // never be spoken over each other.
    stream.on("turn", (turn: TurnEvent) => {
      active.work = active.work
        .then(() => this.onTurn(active, turn))
        .catch((err: unknown) => {
          this.emit("error", toError(err), active.record.callId);
        });
    });
    stream.on("error", (err: Error) => {
      this.emit("error", toError(err), active.record.callId);
    });
    stream.on("close", () => {
      // The STT socket died; the call cannot continue meaningfully.
      this.requestEnd(active, "failed", "realtime session closed");
    });
  }

  /**
   * Handle one finalized caller turn: record it, interrupt the agent if it was
   * still speaking, ask the agent for a reply and play it.
   *
   * Partial turns are ignored — they are for the live UI. Acting on them would
   * have the agent answer half a sentence.
   */
  private async onTurn(active: ActiveCall, turn: TurnEvent): Promise<void> {
    if (active.machine.isEnded) return;
    if (!turn.final) return;
    const text = (turn.utterance ?? turn.transcript ?? "").trim();
    if (text === "") return;

    // Barge-in: the caller spoke while the agent was still talking, so drop
    // the rest of the agent's reply and answer what was just said.
    if (active.session?.localOut.isSpeaking) {
      active.session.localOut.cancel();
      this.emit("bargeIn", active.record.callId);
    }

    this.markTalking(active, "caller turn");
    this.addTranscript(active, {
      speaker: "caller",
      text,
      at: this.now(),
      turnOrder: turn.turnOrder,
    });
    await this.persist(active);

    const reply = await this.opts.agent.onFinalTurn({
      callId: active.record.callId,
      deviceId: active.record.deviceId,
      channelId: active.record.channelId,
      transcript: text,
      turnOrder: turn.turnOrder,
      history: active.record.transcript.map((t) => ({ ...t })),
    });
    if (reply) await this.speak(active, reply);
  }

  /** Play the agent's opening line, if it has one. */
  private async greet(active: ActiveCall): Promise<void> {
    if (!this.opts.agent.onAnswered) return;
    const reply = await this.opts.agent.onAnswered({
      callId: active.record.callId,
      deviceId: active.record.deviceId,
      channelId: active.record.channelId,
      history: [],
    });
    if (reply) await this.speak(active, reply);
  }

  /**
   * Play a reply into the call and bias the next caller turn with it.
   *
   * `agent_context` is pushed even when there is no audio: it tells the model
   * what was just said to the caller, which is what makes a short answer
   * ("yes", an account number) transcribe correctly.
   */
  private async speak(active: ActiveCall, reply: AgentReply): Promise<void> {
    const out = active.session?.localOut;
    if (!out || active.machine.isEnded) return;

    const generation = out.beginUtterance();
    if (reply.audio && reply.audio.length > 0) {
      this.markTalking(active, "agent audio");
      out.speak(reply.audio, {
        ...(reply.sampleRate !== undefined ? { sampleRate: reply.sampleRate } : {}),
        ...(reply.channels !== undefined ? { channels: reply.channels } : {}),
        generation,
      });
    }
    out.endUtterance();

    if (reply.text.trim() !== "") {
      this.addTranscript(active, { speaker: "agent", text: reply.text, at: this.now() });
      try {
        active.stream?.updateConfiguration({
          agent_context: reply.text,
          ...(reply.keyterms ? { keyterms_prompt: reply.keyterms } : {}),
          ...(reply.updateConfiguration ?? {}),
        });
      } catch (err) {
        // Biasing and tuning are accuracy optimisations; losing them must not
        // end a call.
        this.emit("error", toError(err), active.record.callId);
      }
    }
    await this.persist(active);

    if (reply.hangUp) this.requestEnd(active, "completed", "agent ended the call");
  }

  /**
   * Media is flowing in some direction, so the call is under way. Gated on
   * real audio rather than on answering, so a call nobody ever spoke on is
   * correctly recorded as answered-but-never-talking.
   */
  private markTalking(active: ActiveCall, reason: string): void {
    if (active.machine.state === "answered") active.machine.to("talking", reason);
  }

  private addTranscript(active: ActiveCall, entry: TranscriptEntry): void {
    active.record.transcript.push(entry);
    this.emit("transcript", active.record.callId, { ...entry });
  }

  /** Poll the phone so a call the far end hung up does not linger. */
  private startHangupWatch(active: ActiveCall): void {
    const interval = this.opts.hangupPollMs ?? 2000;
    if (interval <= 0) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const state = this.opts.hangupState
            ? await this.opts.hangupState(active.record.deviceId, active.record.channelId)
            : await active.controller.callState();
          if (state === "idle") {
            this.requestEnd(active, "completed", "far end hung up");
          }
        } catch (err) {
          this.emit("error", toError(err), active.record.callId);
          // The device is unreachable (USB pull / WiFi drop / adb crash) — the
          // call cannot continue and the slot must not sit orphaned until the
          // stall watchdog eventually fires. Tear it down now.
          this.requestEnd(active, "failed", "device unreachable");
        }
      })();
    }, interval);
    timer.unref?.();
    active.hangupTimer = timer;
  }

  /** End a live call. Safe to call repeatedly and from any state. */
  endCall(callId: string, outcome: CallOutcome = "completed", reason = "ended by request"): void {
    const active = this.calls.get(callId);
    if (active) this.requestEnd(active, outcome, reason);
  }

  /**
   * Resolve once every in-flight call has been torn down and its record
   * persisted.
   *
   * A call's last `save()` is the final step of `teardown`, so a store that
   * is closed while teardown is still running throws that write away. The
   * app's shutdown ends each live call and awaits this before closing the
   * CRM, so a call still ending at quit time keeps its final record.
   *
   * Idempotent: an empty calls map returns immediately, and a second drain
   * just waits for the same teardowns. Nothing here can throw — every
   * teardown step is individually guarded — but a teardown that never
   * resolves keeps this pending: shutdown prefers waiting for the record to
   * dropping it.
   */
  async drain(): Promise<void> {
    while (this.calls.size > 0) {
      // End anything `endCall` missed, then hand the event loop a turn so the
      // teardown each `finished` promise unblocks can run.
      for (const call of [...this.calls.values()]) call.finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Ask the call loop to finish; teardown happens in `handleIncomingCall`. */
  private requestEnd(active: ActiveCall, outcome: CallOutcome, reason: string): void {
    active.outcome ??= outcome;
    active.endReason ??= reason;
    active.finish();
  }

  /**
   * Take the call down. Every step is independently guarded so that a failure
   * in one cannot skip the rest — above all the realtime session close, which
   * is what stops the meter running.
   */
  private async teardown(active: ActiveCall): Promise<void> {
    if (active.tornDown) return;
    active.tornDown = true;
    const { record } = active;

    if (active.hangupTimer) {
      clearInterval(active.hangupTimer);
      active.hangupTimer = null;
    }

    // Let any in-flight turn finish before pulling the audio graph apart.
    await active.work.catch(() => undefined);

    await this.guard(active, "stop capture", async () => active.capture?.stop());
    await this.guard(active, "close audio session", async () => active.session?.close());

    await this.guard(active, "finalise recording", async () => {
      if (!active.recorder || active.recorder.closed) return;
      const meta = active.recorder.close({ remoteParty: record.remoteParty });
      record.audioPath = meta.wavPath;
    });

    // Always Terminate: a session dropped without it stays billable for hours.
    await this.guard(active, "close realtime session", () =>
      this.opts.sessions.close(
        { deviceId: record.deviceId, channelId: record.channelId },
        active.endReason ?? "call ended",
      ),
    );

    await this.guard(active, "hang up", async () => {
      if (this.opts.endChannelCall) {
        await this.opts.endChannelCall(record.deviceId, record.channelId);
      } else {
        await active.controller.safeHangUp();
      }
    });
    await this.guard(active, "release device", async () =>
      this.opts.devices.setPhase(record.deviceId, "online"),
    );

    active.machine.end(active.endReason ?? "call ended");
    record.endedAt = this.now();
    record.outcome = active.outcome ?? (record.answeredAt === null ? "missed" : "completed");

    await this.guard(active, "persist record", () => this.persist(active));
    await this.guard(active, "notify agent", async () => {
      await this.opts.agent.onCallEnded?.(snapshot(record));
    });
  }

  /** Run a teardown step, reporting failure instead of propagating it. */
  private async guard(active: ActiveCall, what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const error = toError(err);
      this.emit(
        "error",
        new Error(`${what} failed: ${error.message}`, { cause: error }),
        active.record.callId,
      );
    }
  }

  private async persist(active: ActiveCall): Promise<void> {
    const record = snapshot(active.record);
    await this.opts.store.save(record);
    this.emit("call", record);
  }

  private newCallId(deviceId: string): string {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    this.seq += 1;
    return `${deviceId.replace(/[^A-Za-z0-9._-]+/g, "_")}-${stamp}-${this.seq}`;
  }
}

/** Detached copy, so a live call cannot mutate what a caller was handed. */
function snapshot(record: CallRecord): CallRecord {
  return {
    ...record,
    transcript: record.transcript.map((t) => ({ ...t })),
    states: record.states.map((s) => ({ ...s })),
  };
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
