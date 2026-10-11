/** The prompt sets. Every side gets the same text, word for word, and nothing in it favors one tool. */

export const PROMPT_SETS = ["web", "improve", "hobby", "big"] as const;
export type PromptSet = (typeof PROMPT_SETS)[number];
export const STARTERS = ["plain-html", "vite-react"] as const;
export type Starter = (typeof STARTERS)[number];

export interface ComparePrompt {
  id: string;
  set: PromptSet;
  text: string;
  /** Improve prompts: the starter app every side begins from (scripts/compare/starters/<name>). */
  starter?: Starter;
}

/** How long one side may work before it is stopped, per set. `--minutes` overrides it. */
export const SET_MINUTES: Record<PromptSet, number> = { web: 30, improve: 25, hobby: 30, big: 60 };

export const PROMPTS: readonly ComparePrompt[] = [
  { id: "web-focus-timer", set: "web", text: "Build a focus timer web app: 25-minute work and 5-minute break sessions, start, pause and reset, a count of sessions done today, and a sound when a session ends." },
  { id: "web-budget", set: "web", text: "Build a monthly budget web app: add income and expenses with a category, see what is left this month, and a chart of spending by category. Keep the data after a page reload." },
  { id: "web-recipes", set: "web", text: "Build a recipe box web app: add recipes with ingredients and steps, search by ingredient, and make a shopping list from the recipes I pick." },
  { id: "web-habits", set: "web", text: "Build a habit tracker web app: add habits, check them off each day, and see the current streak and a 30-day calendar for each habit." },

  { id: "improve-html-search", set: "improve", starter: "plain-html", text: "This folder has a small web app. Add search and sorting to the list, and let me edit a bottle after it is added." },
  { id: "improve-html-phone", set: "improve", starter: "plain-html", text: "This folder has a small web app. Make it look good and easy to use on a phone, and add a dark mode switch that is remembered." },
  { id: "improve-react-stats", set: "improve", starter: "vite-react", text: "This folder has a small React web app. Add a stats view with a chart of value by set, and a button that exports the cards to a CSV file." },
  { id: "improve-react-filters", set: "improve", starter: "vite-react", text: "This folder has a small React web app. Add filters by set and condition, a way to edit a card, and keep the cards after a page reload." },

  { id: "hobby-bourbon", set: "hobby", text: "Build a bourbon tasting log web app for a local bourbon club: add bottles (name, distillery, proof, age, price), log each member's tasting notes and a 1 to 10 score, and show the club's top-rated bottles." },
  { id: "hobby-cards", set: "hobby", text: "Build a trading card tracker web app for Pokémon and Bo Jackson Battle Arena (BoBA) cards: add cards with set, number, condition and what I paid, mark the ones I still want, and show the collection's total value." },
  { id: "hobby-fishing", set: "hobby", text: "Build a fishing log web app: log each trip with date, spot, weather, bait and the fish caught (kind, length, weight), and show my best spots and best baits." },
  { id: "hobby-3d-prints", set: "hobby", text: "Build a 3D print tracker web app: log prints with the model name, filament type and color, grams used, print time and whether it worked, track how much filament is left on each spool, and show the cost of each print." },

  { id: "big-club", set: "big", text: "Build a full web app for running a small hobby club: member sign-up and login, an events calendar with RSVPs, a shared board for notes and photos, and an admin page to manage members." },
  { id: "big-card-shop", set: "big", text: "Build a full web app for a small online card shop: a product list with search and filters, product pages, a cart and a checkout page with a fake payment, and an admin page to add products and see orders." },
  { id: "big-portfolio", set: "big", text: "Build a full web app for tracking a stock and crypto watchlist: add tickers, enter buys and sells by hand, see profit and loss per holding and in total, charts over time, and price alerts I set. Use made-up sample prices, no paid data feeds." },
];

export const isPromptSet = (value: string): value is PromptSet => (PROMPT_SETS as readonly string[]).includes(value);

/** The set's prompt with the fewest picks so far, so every prompt gets judged; a random one among equals. */
export function pickPrompt(set: PromptSet, picks: ReadonlyMap<string, number>, random: () => number = Math.random): ComparePrompt {
  const prompts = PROMPTS.filter((prompt) => prompt.set === set);
  const fewest = Math.min(...prompts.map((prompt) => picks.get(prompt.id) ?? 0));
  const candidates = prompts.filter((prompt) => (picks.get(prompt.id) ?? 0) === fewest);
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
}
