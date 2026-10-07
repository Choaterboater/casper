/**
 * A provider's error sorted by cause, with one plain next step. Provider text varies by vendor and version, so the
 * rules read words every vendor uses (status codes, "rate limit", "context length"); anything else keeps the
 * provider's own text. The provider's words stay available (ctrl+t, or a second line on a plain terminal).
 */
export type ModelErrorCause = "key" | "refused" | "credits" | "rate" | "offline" | "context" | "model" | "tools";

const RULES: ReadonlyArray<{ cause: ModelErrorCause; test: RegExp; line: string }> = [
  // A model that can't take tools (small local models often can't). The line is built in explainModelError, which has the name.
  { cause: "tools", test: /does not support tools|do(?:es)? not support tool (?:use|calling)|tools? (?:are|is|use is|calling is) not supported|tool use is not supported/i, line: "" },
  // Credits before rate: OpenAI says "exceeded your current quota" with a 429.
  { cause: "credits", test: /\b402\b|payment required|insufficient[_ ](?:credits|funds|quota|balance)|credit balance|requires more credits|exceeded your current quota|billing/i,
    line: "The provider says the account is out of credits. Next: add credits on the provider's site, or /model to pick another model." },
  { cause: "key", test: /\b401\b|unauthori[sz]ed|no auth credentials|(?:invalid|incorrect|missing|expired|revoked)[_ -](?:x-)?(?:api[_ -]?)?(?:key|token)|authentication[_ ]error|api key not valid|not signed in/i,
    line: "The provider rejected the sign-in (the key is wrong or expired). Next: /login to sign in again." },
  // 403 is not always a bad key: the key may be fine but not allowed this model, region or plan.
  { cause: "refused", test: /\b403\b|forbidden|permission[_ ]denied|access[_ ]denied/i,
    line: "The provider refused the request. Next: check the key with /login, or /model to pick a model your account can use." },
  { cause: "context", test: /context[_ ](?:length|window)|maximum context|prompt is too long|input is too long|too many (?:input )?tokens|token limit|context_length_exceeded/i,
    line: "The conversation is too long for this model. Next: /compact, then ask again." },
  { cause: "rate", test: /\b429\b|\b529\b|rate[_ -]?limit|too many requests|overloaded|resource[_ ]exhausted/i,
    line: "The provider is limiting requests right now. Next: wait a minute, then ask again." },
  { cause: "offline", test: /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up|network ?error|connection error|unable to connect|timed out/i,
    line: "Can't reach the provider. Next: check your internet connection, then ask again." },
  { cause: "model", test: /no endpoints found|model\b.{0,80}\b(?:not found|does not exist|is unavailable|not available|not supported)|unknown model|invalid model/i,
    line: "The provider can't run this model. Next: /model to pick another model." },
];

export function explainModelError(message: string): { cause: ModelErrorCause; line: string } | undefined {
  const rule = RULES.find((candidate) => candidate.test.test(message));
  if (rule?.cause === "tools") {
    const named = /([^\s"'`,]*[\w.-])["'`]?\s+does not support tools/i.exec(message)?.[1]?.split("/").pop();
    const model = named && named.length <= 60 ? named : "This model";
    return { cause: "tools", line: `${model} can't use tools, so it can't edit files or run commands here. Pick another model with /model, or use it for questions only.` };
  }
  return rule && { cause: rule.cause, line: rule.line };
}

/** The receipt's "• Next:" for a failed model run, by cause; undefined keeps the usual "try another model". */
export function modelErrorNext(cause: ModelErrorCause | undefined, oneShot: boolean): string | undefined {
  switch (cause) {
    case "key": return oneShot ? "run casper and type /login" : "/login to sign in again";
    case "refused": return oneShot ? "run casper and type /login to check the key, or casper --model <provider/id> \"…\" to use another model" : "check the key with /login, or /model to pick a model your account can use";
    case "credits": return oneShot ? "add credits on the provider's site, or casper --model <provider/id> \"…\" to use another model" : "add credits on the provider's site, or /model to pick another model";
    case "rate": return oneShot ? "wait a minute, then run it again" : "wait a minute, then ask again";
    case "offline": return oneShot ? "check your internet connection, then run it again" : "check your internet connection, then ask again";
    case "context": return oneShot ? "run it again without --continue (the conversation is too long)" : "/compact, then ask again";
    default: return undefined;
  }
}
