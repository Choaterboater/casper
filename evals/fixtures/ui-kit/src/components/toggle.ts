import { escapeHtml } from "../html";

export interface ToggleOptions {
  readonly label: string;
  readonly pressed?: boolean;
}

export interface Toggle {
  render(): string;
  toggle(): void;
  readonly pressed: boolean;
}

/** A two-state button (WAI-ARIA button pattern with aria-pressed). */
export function createToggle(options: ToggleOptions): Toggle {
  if (!options.label.trim()) throw new Error("Toggle: label is required");
  let pressed = options.pressed ?? false;
  return {
    render: () => `<button type="button" aria-pressed="${pressed}">${escapeHtml(options.label)}</button>`,
    toggle() { pressed = !pressed; },
    get pressed() { return pressed; },
  };
}
