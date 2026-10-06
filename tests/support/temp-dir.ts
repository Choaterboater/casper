import { rm } from "node:fs/promises";

/**
 * Remove a test's temp folder. On Windows a folder stays busy while a process has it as its current folder. The
 * usual `git` there (Git\cmd\git.exe) is a launcher that starts the real git; when Casper stops a git call on
 * close, only the launcher stops, and the real git runs on for a moment in the folder. And in a folder that is not
 * a Git repository, a session's start runs two git calls at once and moves on when the first one fails, so the other
 * can still be running there after the app has closed. So the first try can fail with EBUSY. Bun's rm has no retries of its own, so this tries again for up to 2 s.
 */
export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 40 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code)) throw error;
      await Bun.sleep(50);
    }
  }
}
