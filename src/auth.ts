import { AuthMode, type Credentials } from "./generated";

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
      return new AuthMode.LiveKitCloud({
        url: credentials.url,
        token: credentials.token,
      });
    },
  };
}

/** Use your own ai-coustics credentials directly, bypassing LiveKit Cloud. */
function aiCousticsApi(licenseKey: string): AiCousticsApiAuth {
  return {
    provider: "aiCousticsApi",
    licenseKey,
    [toAuthMode]: (): AuthMode | null => {
      return new AuthMode.AiCousticsApi({ licenseKey });
    },
  };
}

export const Auth = {
  livekitCloud,
  aiCousticsApi,
};
