import {
  AudioFrame,
  FrameProcessor,
  type FrameProcessorStreamInfo,
  type FrameProcessorCredentials,
} from "@livekit/rtc-node";
import { DataType, createPointer, restorePointer } from "ffi-rs";

import {
  Enhancer,
  type StreamInfo,
  type Credentials,
  type NativeAudioBufferMut,
  type EnhancerSettings,
  type EnhancerModel,
  type VadSettings,
  type ModelParameters,
} from "./plugins-ai-coustics-uniffi-node";
import { log } from "./logger";
import { type AuthBase, Auth, toAuthMode } from "./auth";

/** The maximum size of a i16 */
const MAX_SHORT_SIZE = 2 ** 15 - 1;

/** Converts a Float32Array into a pointer and length, so it can be passed to the native rust module.
 *
 * The returned `ptr` is the raw address of the backing buffer's memory, obtained by
 * round-tripping through ffi-rs's `createPointer` / `restorePointer` helpers.
 */
function toNativeAudioBufferMut(samples: Float32Array): NativeAudioBufferMut {
  const samplesBuffer = Buffer.from(samples.buffer);
  const sampleLength = samples.length;

  // NOTE: `DataType.U8Array` is intentionally used rather than `DataType.FloatArray`. A Node
  // `Buffer` is a `Uint8Array`, so ffi-rs hands us the true underlying data pointer without
  // copying. `FloatArray` would refuse a `Float32Array` outright ("Object is not array") and,
  // given a plain `number[]`, would allocate its own C-side copy - we'd lose the in-place
  // mutations the rust side writes back. The bytes are the bytes; the u8 view is just how
  // we ask ffi-rs to hand them off.
  const external = createPointer({
    paramsType: [DataType.U8Array],
    paramsValue: [samplesBuffer],
  });
  const [baseAddress] = restorePointer({
    retType: [DataType.BigInt],
    paramsValue: external,
  }) as unknown as [bigint];

  return {
    ptr: baseAddress,
    len: BigInt(sampleLength), // NOTE: len is number of elements in array, NOT number of bytes!
  };
}

/** Attribute used to store associated VAD data (the return value of
 * https://docs.rs/aic-sdk/latest/aic_sdk/struct.Vad.html#method.is_speech_detected) from aic
 * model into processed `AudioFrame`s. */
export const FRAME_USERDATA_AIC_VAD_ATTRIBUTE = "lk.aic-vad";

type AiCousticsAudioEnhancerParams = {
  model?: EnhancerModel;
  vadSettings?: VadSettings;
  modelParameters?: ModelParameters;
  auth?: AuthBase;
};

class AiCousticsAudioEnhancer extends FrameProcessor<AudioFrame> {
  private model: EnhancerModel;
  private vadSettings: VadSettings;
  private modelParameters: ModelParameters;
  private auth: AuthBase;
  private lastErrorMessage: string | null;

  private enabled = true;
  private streamInfo: StreamInfo | null = null;
  private credentials: Credentials | null = null;
  private filterSettings: EnhancerSettings | null = null;
  private filter: Enhancer | null = null;

  constructor(params: AiCousticsAudioEnhancerParams = {}) {
    super();
    this.model = params.model ?? "quailL";
    this.vadSettings = params.vadSettings ?? {};
    this.modelParameters = params.modelParameters ?? {};
    this.auth = params.auth ?? Auth.livekitCloud();
    this.lastErrorMessage = null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  onStreamInfoUpdated(info: FrameProcessorStreamInfo) {
    this.streamInfo = {
      roomId: "",
      roomName: info.roomName,
      participantIdentity: info.participantIdentity,
      participantId: "",
      trackId: info.publicationSid,
    };

    if (this.filter) {
      this.filter.updateStreamInfo(this.streamInfo!);
    }
  }

  onCredentialsUpdated(credentials: FrameProcessorCredentials) {
    this.credentials = credentials;
    if (this.filter) {
      this.filter.updateCredentials(this.credentials!);
    }
  }

  /**
   * Processes a single audio frame.
   *
   * If the frame processor is disabled or processing fails, the original frame is
   * returned unchanged.
   */
  process(frame: AudioFrame): AudioFrame {
    if (!this.isEnabled()) {
      return frame;
    }

    const authMode = this.auth[toAuthMode](this.credentials);
    if (!authMode) {
      this.logProcessFrameError("Missing auth mode");
      return frame;
    }

    if (this.authModeRequiresUpdateCredentialsCall() && !this.credentials) {
      this.logProcessFrameError("Missing credentials");
      return frame;
    }

    if (this.authModeRequiresUpdateStreamInfoCall() && !this.streamInfo) {
      this.logProcessFrameError("Missing stream info");
      return frame;
    }

    // Lazily create filter
    if (
      !this.filter ||
      // implicitly recreate audio filter on sample rate or channel changes
      this.filterSettings?.sampleRate !== frame.sampleRate ||
      this.filterSettings?.numChannels !== frame.channels ||
      this.filterSettings?.samplesPerChannel !== frame.samplesPerChannel
    ) {
      this.filterSettings = {
        model: this.model,
        sampleRate: frame.sampleRate,
        numChannels: frame.channels,
        samplesPerChannel: frame.samplesPerChannel,
        modelParameters: this.modelParameters,
        vad: this.vadSettings,
      };

      this.teardownFilter();
      try {
        this.filter = new Enhancer(authMode, this.filterSettings);
      } catch (err) {
        this.logProcessFrameError(
          this.auth.provider === "aiCousticsApi"
            ? `Failed to initialize plugin core: ${err}. Is your ai-coustics api key correct? Disabling noise cancellation for all following audio frames.`
            : `Failed to initialize plugin core: ${err}. Disabling noise cancellation for all following audio frames.`,
        );
        this.filter = null;
        this.enabled = false;
        return frame;
      }
      if (this.streamInfo) {
        this.filter.updateStreamInfo(this.streamInfo);
      }
    }

    const frameDataI16: Int16Array = frame.data;
    const frameDataF32 = Float32Array.from(
      frameDataI16,
      (short) => short / MAX_SHORT_SIZE,
    );

    const nativeAudioBufferMut = toNativeAudioBufferMut(frameDataF32);

    let vadData: boolean;
    try {
      // NOTE: filter.process processes in place and modifies `frameDataF32`.
      vadData = this.filter.processWithVad(nativeAudioBufferMut);
    } catch (err) {
      this.logProcessFrameError(`Processing failed: ${err}`);
      return frame;
    }

    const outputFrameDataI16 = Int16Array.from(
      frameDataF32,
      (float) => float * MAX_SHORT_SIZE,
    );

    const outputFrame = new AudioFrame(
      outputFrameDataI16,
      frame.sampleRate,
      frame.channels,
      frame.samplesPerChannel,
      frame.userdata,
    );

    outputFrame.userdata[FRAME_USERDATA_AIC_VAD_ATTRIBUTE] = vadData;
    return outputFrame;
  }

  /**
   * Does the given auth mode require updateStreamInfo be called?
   */
  private authModeRequiresUpdateStreamInfoCall() {
    return this.auth.provider === "livekitCloud";
  }

  /**
   * Does the given auth mode require updateCredentials be called?
   *
   * Note that this is just here to provide helpful warnings to users,
   * the actual auth layer is in the rust core.
   */
  private authModeRequiresUpdateCredentialsCall() {
    return this.auth.provider === "livekitCloud";
  }

  /**
   * Logs a new error to the screen when processing a frame.
   * Only shows logs which were newly introduced as compared with the
   * last processed frame.
   */
  private logProcessFrameError(message: string) {
    if (this.lastErrorMessage === message) {
      return;
    }
    this.lastErrorMessage = message;
    log.error(message);
  }

  private teardownFilter() {
    if (this.filter) {
      this.filter.uniffiDestroy();
      this.filter = null;
    }
  }

  close() {
    this.enabled = false;
    this.teardownFilter();
  }
}

export type AudioEnhancementParams = AiCousticsAudioEnhancerParams;

type DeprecatedModels = "sparrowS";

type NonDeprecatedAudioEnhancementParams = Omit<
  AudioEnhancementParams,
  "model"
> & {
  model?: Exclude<EnhancerModel, DeprecatedModels>;
};

/**
 * Implements a mechanism to apply [ai-coustics models](https://ai-coustics.com/) on audio data
 * represented as {@link AudioFrame}s. In addition, each frame will be annotated with a
 * {@link FRAME_USERDATA_AIC_VAD_ATTRIBUTE } `userdata` attribute containing the output of the
 * aic vad model.
 **/
export function audioEnhancement(
  params?: NonDeprecatedAudioEnhancementParams,
): AiCousticsAudioEnhancer;
/**
 * Implements a mechanism to apply [ai-coustics models](https://ai-coustics.com/) on audio data
 * represented as {@link AudioFrame}s. In addition, each frame will be annotated with a
 * {@link FRAME_USERDATA_AIC_VAD_ATTRIBUTE } `userdata` attribute containing the output of the
 * aic vad model.
 * @deprecated Set model to rookS instead, sparrowS is deprecated.
 **/
export function audioEnhancement(
  params: AudioEnhancementParams,
): AiCousticsAudioEnhancer;
export function audioEnhancement(params?: AudioEnhancementParams) {
  return new AiCousticsAudioEnhancer(params);
}
