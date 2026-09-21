/**
 * Environment for a spawned adapter, browser or development server: the OS
 * variables a process needs to start at all, never inherited provider
 * credentials. `home` becomes the isolated user directory for that process.
 */
export function isolatedEnvironment(home: string, additions: Record<string, string> = {}): Record<string, string> {
  if (process.platform !== "win32") return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, ...additions };
  // Windows programs resolve the user directory from USERPROFILE and the
  // loader/console paths from SystemRoot, so those cannot be dropped the way
  // POSIX tools tolerate a HOME-only environment.
  const env: Record<string, string> = {};
  for (const name of ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "ProgramData", "ProgramFiles", "ProgramFiles(x86)"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.PATH = process.env.PATH ?? "";
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = home;
  env.LOCALAPPDATA = home;
  env.TEMP = home;
  env.TMP = home;
  return { ...env, ...additions };
}