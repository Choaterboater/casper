import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

// pi-ai loads each provider's OAuth flow through a variable import() that a bundler cannot
// follow, so a compiled binary has no flow modules to load: every stored sign-in failed with
// "Cannot find module './github-copilot.js'". Register the statically imported flows instead.
// From source this only replaces a lazy import with an eager one.
registerBunOAuthFlows();
