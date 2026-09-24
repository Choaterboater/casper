import type { Tool } from "../tool";
import { setInterfaceDescription } from "./set-interface-description";
import { showVersion } from "./show-version";

export const deviceTools: readonly Tool[] = [setInterfaceDescription, showVersion];
