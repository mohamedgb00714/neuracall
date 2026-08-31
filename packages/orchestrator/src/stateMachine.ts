/**
 * The per-call state machine.
 *
 * A call moves idle → incoming → answered → talking → ended, and `ended` is
 * terminal. Every state may jump straight to `ended`, because a call can fail
 * or be hung up at any point — the phone rejects the answer keyevent, the
 * caller gives up while ringing, the WebSocket dies. That single escape hatch
 * is what lets the orchestrator's cleanup path be unconditional: whatever went
 * wrong, `ended` is always reachable, so the A2I session always gets
 * terminated and the device always goes back in the pool.
 *
 * Transitions are validated rather than assumed. An illegal transition is a
 * bug in the caller (answering a call that already ended, transcribing one
 * that was never answered), and silently allowing it would leave a device
 * marked busy forever or a billable STT session with nothing to close it.
 */

import { EventEmitter } from "node:events";

/** Lifecycle states of a single call. */
export type CallState = "idle" | "incoming" | "answered" | "talking" | "ended";

/** States in their natural order, for display and assertions. */
export const CALL_STATES: readonly CallState[] = [
  "idle",
  "incoming",
  "answered",
  "talking",
  "ended",
] as const;

/** Which states each state may move to. `ended` is terminal. */
const TRANSITIONS: Record<CallState, readonly CallState[]> = {
  idle: ["incoming", "ended"],
  incoming: ["answered", "ended"],
  answered: ["talking", "ended"],
  talking: ["ended"],
  ended: [],
};

/** One entry in a call's state history. */
export interface StateTransition {
  from: CallState;
  to: CallState;
  /** ms since epoch. */
  at: number;
  /** Why the transition happened, for the call record and for debugging. */
  reason?: string;
}

export interface CallStateMachineOptions {
  /** Starting state. Default "idle". */
  initial?: CallState;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/**
 * Tracks one call's state and rejects illegal moves.
 *
 * Events:
 *  - "transition" (t: StateTransition)  every accepted move
 *  - "<state>"    (t: StateTransition)  one per state, e.g. "answered"
 */
export class CallStateMachine extends EventEmitter {
  private current: CallState;
  private readonly now: () => number;
  private readonly log: StateTransition[] = [];

  constructor(opts: CallStateMachineOptions = {}) {
    super();
    this.current = opts.initial ?? "idle";
    this.now = opts.now ?? Date.now;
  }

  get state(): CallState {
    return this.current;
  }

  get isEnded(): boolean {
    return this.current === "ended";
  }

  /** Every transition so far, oldest first. */
  get history(): StateTransition[] {
    return [...this.log];
  }

  /** The states this call has been in, including the one it started in. */
  get visited(): CallState[] {
    return [this.log[0]?.from ?? this.current, ...this.log.map((t) => t.to)];
  }

  /** When the call entered `state`, or undefined if it never did. */
  enteredAt(state: CallState): number | undefined {
    return this.log.find((t) => t.to === state)?.at;
  }

  /** Whether `next` is a legal move from the current state. */
  can(next: CallState): boolean {
    return TRANSITIONS[this.current].includes(next);
  }

  /**
   * Move to `next`. Throws on an illegal transition — see the module comment
   * for why this is loud rather than forgiving.
   */
  to(next: CallState, reason?: string): StateTransition {
    if (!this.can(next)) {
      throw new Error(
        `Illegal call transition ${this.current} -> ${next}` +
          (reason ? ` (${reason})` : "") +
          `. Legal from ${this.current}: ${TRANSITIONS[this.current].join(", ") || "(none)"}.`,
      );
    }
    const transition: StateTransition = { from: this.current, to: next, at: this.now() };
    if (reason !== undefined) transition.reason = reason;
    this.current = next;
    this.log.push(transition);
    this.emit("transition", transition);
    this.emit(next, transition);
    return transition;
  }

  /**
   * Move to `ended` unless already there. Returns whether this call did it.
   * Cleanup paths use this so that tearing a call down twice — say a hangup
   * racing an error — is harmless.
   */
  end(reason?: string): boolean {
    if (this.current === "ended") return false;
    this.to("ended", reason);
    return true;
  }
}
