import { health } from "./health";
import { createRouter } from "./router";

export const router = createRouter({ "GET /health": health });
