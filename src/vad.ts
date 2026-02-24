// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from "@livekit/rtc-node";
import {
  VADEventType,
  VADStream as BaseStream,
  VAD as BaseVAD,
  Plugin,
} from "@livekit/agents";
import { FRAME_USERDATA_AIC_VAD_ATTRIBUTE } from "./processor";

const SPEECH_BUFFER_MS = 3000;

export class AICousticsVAD extends BaseVAD {
  private streams: AICousticsVADStream[] = [];
  label = "lk.ai-coustics-vad";

  constructor() {
    super({
      updateInterval: 20, // this isn't used but required to satisfy the base class constructor
    });
  }

  stream(): AICousticsVADStream {
    const stream = new AICousticsVADStream(this);
    this.streams.push(stream);
    return stream;
  }

  async close(): Promise<void> {
    for (const stream of this.streams) {
      stream.close();
    }
    this.streams = [];
  }
}

export class AICousticsVADStream extends BaseStream {
  private task: Promise<void>;
  private hasNoMetadata = false;

  constructor(vad: AICousticsVAD) {
    super(vad);

    this.task = this.processFrames();
  }

  private async processFrames(): Promise<void> {
    let sampleRate = 0;
    let speaking = false;
    let speechFrameCount = 0;
    let silenceFrameCount = 0;
    let speechBuffer: AudioFrame[] = [];
    let currentSample = 0;
    let timestamp = 0;
    let speechDuration = 0;
    let silenceDuration = 0;

    try {
      while (!this.closed) {
        const { done, value: frame } = await this.inputReader.read();
        if (done) {
          break;
        }

        if (typeof frame === "symbol") {
          // Handle flush sentinel
          continue;
        }

        // Initialize sample rate from first frame
        if (!sampleRate) {
          sampleRate = frame.sampleRate;
        } else if (frame.sampleRate !== sampleRate) {
          this.logger.warn(
            "frame with different sample rate detected, skipping",
          );
          continue;
        }

        // Extract VAD metadata from userData
        const userData = frame.userdata;
        const vadMetadata: boolean | undefined = userData?.[
          FRAME_USERDATA_AIC_VAD_ATTRIBUTE
        ] as boolean;

        if (vadMetadata === undefined) {
          if (!this.hasNoMetadata) {
            this.logger.error(
              `No VAD metadata found in frame.userData.${FRAME_USERDATA_AIC_VAD_ATTRIBUTE}, 
              make sure that you are using aic.audioEnhancement() on the audio input. 
              This VAD plugin relies on its preprocessing.`,
            );
          }
          this.hasNoMetadata = true;

          continue;
        } else {
          this.hasNoMetadata = false;
        }

        const isSpeaking = vadMetadata;
        const frameDuration = (frame.samplesPerChannel / sampleRate) * 1000;

        currentSample += frame.samplesPerChannel;
        timestamp += frameDuration;

        // Update duration counters
        if (speaking) {
          speechDuration += frameDuration;
        } else {
          silenceDuration += frameDuration;
        }

        // Always emit INFERENCE_DONE for metrics and monitoring
        this.sendVADEvent({
          type: VADEventType.INFERENCE_DONE,
          samplesIndex: currentSample,
          timestamp,
          speechDuration,
          silenceDuration,
          probability: 1,
          inferenceDuration: 0, // No actual inference
          frames: [frame],
          speaking,
          rawAccumulatedSilence: silenceFrameCount,
          rawAccumulatedSpeech: speechFrameCount,
        });

        // Track speech buffer for START_OF_SPEECH and END_OF_SPEECH events
        speechBuffer.push(frame);

        if (isSpeaking) {
          speechFrameCount++;
          silenceFrameCount = 0;

          // Trigger START_OF_SPEECH
          if (!speaking) {
            speaking = true;
            silenceDuration = 0;
            this.logger.debug("START_OF_SPEECH");

            this.sendVADEvent({
              type: VADEventType.START_OF_SPEECH,
              samplesIndex: currentSample,
              timestamp,
              speechDuration:
                speechFrameCount * this.vad.capabilities.updateInterval,
              silenceDuration: 0,
              probability: 1,
              inferenceDuration: 0,
              frames: [...speechBuffer],
              speaking: true,
              rawAccumulatedSilence: 0,
              rawAccumulatedSpeech: speechFrameCount,
            });
          }
        } else {
          silenceFrameCount++;
          speechFrameCount = 0;

          // Trigger END_OF_SPEECH
          if (speaking) {
            speaking = false;
            speechDuration = 0;
            this.logger.debug("END_OF_SPEECH");

            this.sendVADEvent({
              type: VADEventType.END_OF_SPEECH,
              samplesIndex: currentSample,
              timestamp,
              speechDuration: 0,
              silenceDuration:
                silenceFrameCount * this.vad.capabilities.updateInterval,
              probability: 1,
              inferenceDuration: 0,
              frames: [...speechBuffer],
              speaking: false,
              rawAccumulatedSilence: silenceFrameCount,
              rawAccumulatedSpeech: 0,
            });

            // Clear speech buffer after END_OF_SPEECH
            speechBuffer = [];
          }
        }

        // Keep buffer size manageable (e.g., last 60 seconds at 50 frames/sec = 3000 frames)
        if (speechBuffer.length > SPEECH_BUFFER_MS) {
          speechBuffer = speechBuffer.slice(-SPEECH_BUFFER_MS);
        }
      }
    } catch (error) {
      this.logger.error("error processing frames", error);
    }
  }
}

class AICPlugin extends Plugin {
  constructor() {
    super({
      title: "ai-coustics-vad",
      version: "",
      package: "@livekit/plugins-ai-coustics",
    });
  }
}

Plugin.registerPlugin(new AICPlugin());

/**
 * A VAD implementation that relies on the accompanying ai coustics {@link audioEnhancement} FrameProcessor
 * instead of performing its own inference.
 *
 */
export function vad() {
  return new AICousticsVAD();
}
