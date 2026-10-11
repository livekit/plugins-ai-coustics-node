import {
  AudioFrame,
  FrameProcessor,
  type FrameProcessorStreamInfo,
  type FrameProcessorCredentials,
} from "@livekit/rtc-node";

import {
  Enhancer,
  modelParametersEqual,
  EnhancerModel,
  type StreamInfo,
  type Credentials,
  type EnhancerSettings,
  type VadSettings,
  type ModelParameters,
} from "./generated";
import { log } from "./logger";
import { type AuthBase, Auth, toAuthMode } from "./auth";

/** The maximum size of a i16 */
const MAX_SHORT_SIZE = 2 ** 15 - 1;

/** Attribute used to store associated VAD data (the return value of
 * https://docs.rs/aic-sdk/latest/aic_sdk/struct.EnergyVadContext.html#method.is_speech_detected) from aic
 * model into processed `AudioFrame`s. */
export const FRAME_USERDATA_AIC_VAD_ATTRIBUTE = "lk.aic-vad";

/**
 * The string form of an {@link EnhancerModel}, accepted anywhere a model can be specified.
 *
 * Before 0.3.0 `EnhancerModel` was this string union rather than an enum; both spellings are
 * supported so code written against either version keeps working.
 */
export type EnhancerModelName =
  | "quailL"
  | "quailVfL"
  | "quailVfS"
  | "sparrowS"
  | "rookS";

/** A model specified either as an {@link EnhancerModel} member or as its {@link EnhancerModelName}. */
export type EnhancerModelLike = EnhancerModel | EnhancerModelName;

const ENHANCER_MODELS_BY_NAME = {
  quailL: EnhancerModel.QuailL,
  quailVfL: EnhancerModel.QuailVfL,
  quailVfS: EnhancerModel.QuailVfS,
  sparrowS: EnhancerModel.SparrowS,
  rookS: EnhancerModel.RookS,
} as const satisfies Record<EnhancerModelName, EnhancerModel>;

/**
 * Resolves either spelling of a model into the {@link EnhancerModel} member the generated
 * bindings expect.
 *
 * Validating here matters most for plain JavaScript callers: the generated FfiConverter's write
 * path has no default branch, so a value matching none of the enum members writes nothing while
 * `allocationSize` still reserves its four bytes - a silently malformed payload across the FFI
 * boundary rather than an error at the call site.
 */
function toEnhancerModel(model: EnhancerModelLike): EnhancerModel {
  const resolved =
    typeof model === "string"
      ? ENHANCER_MODELS_BY_NAME[model as EnhancerModelName]
      : model;
  if (
    typeof resolved === "undefined" ||
    typeof EnhancerModel[resolved] === "undefined"
  ) {
    throw new TypeError(
      `Unknown ai-coustics enhancer model ${JSON.stringify(model)}: expected an EnhancerModel member, or one of ${Object.keys(ENHANCER_MODELS_BY_NAME).join(", ")}.`,
    );
  }
  return resolved;
}

type AiCousticsAudioEnhancerParams = {
  model?: EnhancerModelLike;
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
    this.model = toEnhancerModel(params.model ?? EnhancerModel.QuailL);
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

  /**
   * Updates the model parameters on the running model.
   *
   * The native core must already exist (i.e. at least one audio frame must
   * have been processed) for the update to take effect; otherwise the call
   * is a no-op and a warning is logged. The new parameters are also stored
   * so they are reapplied if the native core is later recreated (e.g. on a
   * sample-rate or channel change).
   */
  updateModelParameters(modelParameters: ModelParameters) {
    if (!this.filter) {
      log.warn("update_model_parameters: Native core not yet initialized, skipping. Process at least one audio frame first.");
      return;
    }
    if (modelParametersEqual(modelParameters, this.modelParameters)) {
      return;
    }
    this.modelParameters = modelParameters;
    this.filter.updateModelParameters(modelParameters);
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
        this.logProcessFrameError(this.auth.provider === "aiCousticsApi" ? (
          `Failed to initialize plugin core: ${err}. Is your ai-coustics api key correct? Disabling noise cancellation for all following audio frames.`
        ) : (
          `Failed to initialize plugin core: ${err}. Disabling noise cancellation for all following audio frames.`
        ));
        this.filter = null;
        this.enabled = false;
        return frame;
      }
      if (this.streamInfo) {
        this.filter.updateStreamInfo(this.streamInfo);
      }
    }

    const frameDataI16: Int16Array = frame.data;
    const samples: number[] = Array.from(
      frameDataI16,
      (short) => short / MAX_SHORT_SIZE,
    );

    let vadData: boolean;
    let processed: number[];
    try {
      const result = this.filter.processOwnedWithVad(samples);
      processed = result.frame;
      vadData = result.vad;
    } catch (err) {
      this.logProcessFrameError(`Processing failed: ${err}`);
      return frame;
    }

    const outputFrameDataI16 = Int16Array.from(
      processed,
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

// Both spellings have to be listed: `EnhancerModel` is a numeric enum, so excluding only the
// string name would filter nothing out of the union (and vice versa).
type DeprecatedModels = EnhancerModel.SparrowS | "sparrowS";

type NonDeprecatedAudioEnhancementParams = Omit<
  AudioEnhancementParams,
  "model"
> & {
  model?: Exclude<EnhancerModelLike, DeprecatedModels>;
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
