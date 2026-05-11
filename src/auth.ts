import type { AuthMode, Credentials } from "./plugins-ai-coustics-uniffi-node";

// Internal symbols - not exported, so they're inaccessible to consumers.
export const toAuthMode = Symbol("lk.aic.node.toAuthMode");

export type AuthBase = {
  provider: string;
  /** @internal */
  [toAuthMode]: (credentials: Credentials | null) => AuthMode | null;
};

export interface LiveKitCloudAuth extends AuthBase {
  provider: "livekitCloud";
}

export interface AiCousticsApiAuth extends AuthBase {
  provider: "aiCousticsApi";
  licenseKey: string;
}

/** Use LiveKit Cloud for ai-coustics authentication and billing (default). */
function livekitCloud(): LiveKitCloudAuth {
  return {
    provider: "livekitCloud",
    [toAuthMode]: (credentials: Credentials | null): AuthMode | null => {
      if (!credentials) {
        return null;
      }
      return {
        tag: "liveKitCloud",
        inner: {
          url: credentials.url,
          token: credentials.token,
        },
      };
    },
  };
}

/** Use your own ai-coustics credentials directly, bypassing LiveKit Cloud. */
function aiCousticsApi(licenseKey: string): AiCousticsApiAuth {
  return {
    provider: "aiCousticsApi",
    licenseKey,
    [toAuthMode]: (): AuthMode | null => {
      return { tag: "aiCousticsApi", inner: { licenseKey } };
    },
  };
}

export const Auth = {
  livekitCloud,
  aiCousticsApi,
};
