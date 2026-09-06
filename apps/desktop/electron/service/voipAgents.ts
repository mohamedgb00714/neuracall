import {
  type VoiceAgentDefinition,
  type VoiceAgentInlineConfig,
  type VoiceAgentInput,
  type VoiceAgentInputConfig,
  type VoiceId,
} from "@neuracall/aai-client";
import type { VoiceAgentClientConfig } from "@neuracall/orchestrator";
import type { DeviceAgentConfig, NeuraCallSettings } from "./settings.js";

/**
 * The per-device agent feature in three lines:
 *
 * The operator fills one `DeviceAgentConfig` per attached phone in Settings.
 * Saving it against the REST agents API hands back a stored agent's uuid, which
 * is persisted so the device is bound to that agent from then on. At call time
 * the bridge consults `voiceAgentFor()` and binds the session to the device's
 * own agent — falling back to the global `voiceAgent` configuration when that
 * device has none.
 */

/** The stored-agent API shape derived from the Settings form. */
export function storedAgentDefinition(
  config: DeviceAgentConfig,
  deviceLabel: string,
): VoiceAgentDefinition {
  const input: VoiceAgentInput = {};
  if (config.keyterms.length > 0) input.keyterms = [...config.keyterms];
  if (config.transcriptionMode !== null) {
    input.transcriptionMode = config.transcriptionMode;
  }
  if (config.voiceFocus !== null) input.voiceFocus = config.voiceFocus;
  if (config.voiceFocusThreshold !== null) {
    input.voiceFocusThreshold = config.voiceFocusThreshold;
  }
  const detection = turnDetectionWire(config);
  if (detection !== undefined) input.turnDetection = detection;

  return {
    name: config.name.trim() || deviceLabel,
    systemPrompt: config.systemPrompt,
    ...(config.greeting !== "" ? { greeting: config.greeting } : {}),
    voice: config.voice as VoiceId,
    ...(Object.keys(input).length > 0 ? { input } : {}),
    ...(config.volume !== null ? { output: { volume: config.volume } } : {}),
  };
}

/** The inline-session shape derived from a device that has no stored agent. */
export function deviceAgentClientConfig(config: DeviceAgentConfig): VoiceAgentClientConfig {
  if (config.agentId !== "") return { agentId: config.agentId };

  const input: VoiceAgentInputConfig = {};
  if (config.keyterms.length > 0) input.keyterms = [...config.keyterms];
  if (config.transcriptionMode !== null) {
    input.transcription_mode = config.transcriptionMode;
  }
  if (config.voiceFocus !== null) input.voice_focus = config.voiceFocus;
  if (config.voiceFocusThreshold !== null) {
    input.voice_focus_threshold = config.voiceFocusThreshold;
  }
  const detection = turnDetectionWire(config);
  if (detection !== undefined) {
    input.turn_detection = {
      ...(detection.vadThreshold !== undefined
        ? { vad_threshold: detection.vadThreshold }
        : {}),
      ...(detection.minSilence !== undefined ? { min_silence: detection.minSilence } : {}),
      ...(detection.maxSilence !== undefined ? { max_silence: detection.maxSilence } : {}),
      ...(detection.interruptResponse !== undefined
        ? { interrupt_response: detection.interruptResponse }
        : {}),
      ...(detection.interruptionDelayMs !== undefined
        ? { interruption_delay: detection.interruptionDelayMs }
        : {}),
    };
  }
  const session: VoiceAgentInlineConfig = {
    ...(config.voice !== "" ? { voice: config.voice } : {}),
    ...(config.systemPrompt !== "" ? { system_prompt: config.systemPrompt } : {}),
    ...(config.greeting !== "" ? { greeting: config.greeting } : {}),
  };
  if (Object.keys(input).length > 0) session.input = input;
  return { session };
}

/**
 * The bridge's per-device resolver. Reads the *live* settings object, so a
 * save made while the app runs is picked up on the next call without the
 * autopilot being rebuilt.
 */
export function voiceAgentFor(settings: NeuraCallSettings) {
  return (key: { deviceId: string; channelId: string }): VoiceAgentClientConfig | undefined => {
    const config = settings.voipAgents[key.deviceId];
    return config === undefined ? undefined : deviceAgentClientConfig(config);
  };
}

/** Turn-detection knob values, nulls dropped, so a call only sets what was set. */
function turnDetectionWire(
  config: DeviceAgentConfig,
): VoiceAgentInput["turnDetection"] | undefined {
  const knobs = config.turnDetection;
  if (
    knobs.vadThreshold === null &&
    knobs.minSilenceMs === null &&
    knobs.maxSilenceMs === null &&
    knobs.interruptResponse &&
    knobs.interruptionDelayMs === null
  ) {
    return undefined;
  }
  const wire: VoiceAgentInput["turnDetection"] = {};
  if (knobs.vadThreshold !== null) wire.vadThreshold = knobs.vadThreshold;
  if (knobs.minSilenceMs !== null) wire.minSilence = knobs.minSilenceMs;
  if (knobs.maxSilenceMs !== null) wire.maxSilence = knobs.maxSilenceMs;
  wire.interruptResponse = knobs.interruptResponse;
  if (knobs.interruptionDelayMs !== null) {
    wire.interruptionDelayMs = knobs.interruptionDelayMs;
  }
  return wire;
}