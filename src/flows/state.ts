import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectStateDirectory } from "../project/model";

/** Ignored this many times in a row in one project, a suggestion is hidden there for a while. */
export const FADE_AFTER_IGNORES = 3;
export const FADE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The key hint under the suggestions shows this many times, then only the numbers remain. */
export const HINT_TIMES = 3;

export type SuggestionStatus = "on" | "off" | "faded";

export interface RuleRecord {
  shown: number;
  ignoredInRow: number;
  /** Epoch milliseconds; hidden in this project until then. */
  hiddenUntil?: number;
}

interface ProjectFile {
  version: 1;
  rules: Record<string, RuleRecord>;
  hintsShown: number;
}

interface UserFile {
  version: 1;
  /** Every suggestion off, everywhere. */
  off: boolean;
  /** These suggestions off, everywhere. */
  offIds: string[];
}

export interface SuggestionStateOptions {
  root: string;
  homeDir: string;
  /** `suggestions: false` in ~/.casper/config.yaml or a profile. */
  configOff?: boolean;
  now?: () => number;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function emptyProject(): ProjectFile { return { version: 1, rules: {}, hintsShown: 0 }; }
function emptyUser(): UserFile { return { version: 1, off: false, offIds: [] }; }

const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function validProject(value: unknown): value is ProjectFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Partial<ProjectFile>;
  if (file.version !== 1 || !count(file.hintsShown) || !file.rules || typeof file.rules !== "object" || Array.isArray(file.rules)) return false;
  return Object.entries(file.rules).every(([id, record]) => ID.test(id) && record && typeof record === "object"
    && count(record.shown) && count(record.ignoredInRow) && (record.hiddenUntil === undefined || count(record.hiddenUntil)));
}

function validUser(value: unknown): value is UserFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Partial<UserFile>;
  return file.version === 1 && typeof file.off === "boolean" && Array.isArray(file.offIds)
    && file.offIds.every((id) => typeof id === "string" && ID.test(id));
}

async function readJson<T>(file: string, valid: (value: unknown) => value is T): Promise<{ value?: T; corrupt: boolean }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { corrupt: false };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return valid(value) ? { value, corrupt: false } : { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

/** Temporary file, then rename: a crash never leaves half a file. Owner-only, like skills-trust.json. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * What Casper remembers about suggestions. Per project: how often each was shown and ignored, and when a
 * faded one comes back. Per user: which are off. Nothing here costs tokens or reaches the model.
 */
export class SuggestionState {
  /** "[suggestions] state reset" when a file could not be read and was started again. */
  readonly notices: string[] = [];
  private project: ProjectFile = emptyProject();
  private user: UserFile = emptyUser();
  private readonly now: () => number;
  readonly projectFile: string;
  readonly userFile: string;

  private constructor(private readonly options: SuggestionStateOptions) {
    this.now = options.now ?? Date.now;
    this.projectFile = path.join(projectStateDirectory(options.root, options.homeDir), "suggestions.json");
    this.userFile = path.join(options.homeDir, ".casper", "suggestions.json");
  }

  static async load(options: SuggestionStateOptions): Promise<SuggestionState> {
    const state = new SuggestionState(options);
    const project = await readJson(state.projectFile, validProject);
    const user = await readJson(state.userFile, validUser);
    if (project.value) state.project = project.value;
    if (user.value) state.user = user.value;
    // A broken file is started again, said once, and rewritten whole right away.
    if (project.corrupt) {
      state.notices.push(`[suggestions] state reset (${state.projectFile} could not be read)`);
      await writeJson(state.projectFile, state.project);
    }
    if (user.corrupt) {
      state.notices.push(`[suggestions] state reset (${state.userFile} could not be read)`);
      await writeJson(state.userFile, state.user);
    }
    return state;
  }

  /** Every suggestion off: the config setting or /suggestions off. */
  get allOff(): boolean {
    return Boolean(this.options.configOff) || this.user.off;
  }

  /** Off because of `suggestions: false` in the user's config; /suggestions on cannot change that. */
  get offByConfig(): boolean {
    return Boolean(this.options.configOff);
  }

  status(id: string): SuggestionStatus {
    if (this.allOff || this.user.offIds.includes(id)) return "off";
    const hiddenUntil = this.project.rules[id]?.hiddenUntil;
    return hiddenUntil !== undefined && hiddenUntil > this.now() ? "faded" : "on";
  }

  visible(id: string): boolean {
    return this.status(id) === "on";
  }

  /** When a faded suggestion comes back, for /suggestions. */
  hiddenUntil(id: string): Date | undefined {
    const until = this.project.rules[id]?.hiddenUntil;
    return until !== undefined && until > this.now() ? new Date(until) : undefined;
  }

  /** Whether the key hint should show under the suggestions this time. */
  get hintDue(): boolean {
    return this.project.hintsShown < HINT_TIMES;
  }

  private record(id: string): RuleRecord {
    if (!ID.test(id)) throw new Error(`invalid suggestion id ${JSON.stringify(id)}`);
    return this.project.rules[id] ??= { shown: 0, ignoredInRow: 0 };
  }

  async recordShown(ids: readonly string[], hintShown = false): Promise<void> {
    for (const id of ids) this.record(id).shown += 1;
    if (hintShown) this.project.hintsShown += 1;
    await this.saveProject();
  }

  /** Shown but not chosen before the next request. The third time in a row hides it for 14 days. */
  async recordIgnored(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const record = this.record(id);
      record.ignoredInRow += 1;
      if (record.ignoredInRow >= FADE_AFTER_IGNORES) {
        record.hiddenUntil = this.now() + FADE_DAYS * DAY_MS;
        record.ignoredInRow = 0;
      }
    }
    await this.saveProject();
  }

  /** Choosing a suggestion resets its fading. */
  async recordChosen(id: string): Promise<void> {
    const record = this.record(id);
    record.ignoredInRow = 0;
    delete record.hiddenUntil;
    await this.saveProject();
  }

  /** /suggestions off [name] and /suggestions on [name]. Without a name it is every suggestion. Turning
   * one on also brings it back if it had faded here. */
  async setOff(off: boolean, id?: string): Promise<void> {
    if (id === undefined) {
      this.user.off = off;
      if (!off) this.user.offIds = [];
    } else {
      if (!ID.test(id)) throw new Error(`invalid suggestion id ${JSON.stringify(id)}`);
      this.user.offIds = off ? [...new Set([...this.user.offIds, id])] : this.user.offIds.filter((item) => item !== id);
      if (!off) {
        const record = this.project.rules[id];
        if (record) { delete record.hiddenUntil; record.ignoredInRow = 0; }
        await this.saveProject();
      }
    }
    await writeJson(this.userFile, this.user);
  }

  private async saveProject(): Promise<void> {
    await writeJson(this.projectFile, this.project);
  }
}
