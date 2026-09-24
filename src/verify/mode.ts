import type { ProjectCommand } from "../project/model";

/** `auto`: Casper runs the selected checks after the model's edits. `offer`: the model may use
 * casper_check and the receipt suggests /verify. `off`: no managed checks during tasks. */
export type VerificationMode = "offer" | "auto" | "off";
export const VERIFICATION_MODES: readonly VerificationMode[] = ["offer", "auto", "off"];

export interface VerificationSettings {
  timeoutMs: number;
  /** Unset means "not configured": the surface picks its default. */
  mode?: VerificationMode;
  /** Unset means every configured check. */
  checks?: ProjectCommand[];
}
