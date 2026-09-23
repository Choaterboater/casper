import type { RuntimeLoginIO, RuntimePickerIO } from "../../src/runtime/types";
import { TerminalSurface } from "../../src/tui/surface";

/** Exercise auth through the same rendering/input boundary as the interactive app. */
export async function withLoginSurface<T>(io: RuntimePickerIO, operation: (io: RuntimeLoginIO) => Promise<T>): Promise<T> {
  const surface = new TerminalSurface(io, () => {}, io.onEOF);
  surface.start();
  try { return await surface.exclusiveHost()!.run(operation); }
  finally { surface.close(); }
}
