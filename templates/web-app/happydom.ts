import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Gives bun test a document and window, so page tests can render React.
GlobalRegistrator.register();
