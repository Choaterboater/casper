import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Conservative on purpose: even a quoted example of a consequential command stays visible. */
export const consequentialLine = (line: string): boolean =>
  /\b(?:push|rm|del|curl|wget|irm|sudo|install|ci|add)\b|>/i.test(line);

/** First eight, last three, with consequential middle lines below the gap. Existing gaps retain their count.
 * The budget counts terminal rows; essential lines are never cut to satisfy it. */
export function commandPreview(lines: readonly string[], budget = 12, width = Infinity): string[] {
  let priorHidden = 0;
  const command = lines.filter(line => {
    const gap = /^… (\d+) more lines$/.exec(line);
    if (!gap) return true;
    priorHidden += Number(gap[1]);
    return false;
  });
  const rows = (line: string) => Number.isFinite(width) && visibleWidth(line) > width ? wrapTextWithAnsi(line, width).length : 1;
  if (!priorHidden && command.reduce((sum, line) => sum + rows(line), 0) <= budget) return [...command];
  const tail = Math.max(0, command.length - 3);
  const essential = new Set(command.flatMap((line, at) => at >= tail || consequentialLine(line) ? [at] : []));
  const priorGap = lines.findIndex(line => /^… \d+ more lines$/.test(line));
  let first = Math.min(8, tail, priorGap < 0 ? 8 : priorGap);
  const selected = () => new Set([...essential, ...Array.from({ length: first }, (_, at) => at)]);
  const cost = () => 1 + [...selected()].reduce((sum, at) => sum + rows(command[at]!), 0);
  while (first > 0 && cost() > budget) first--;
  const keep = selected();
  const hidden = priorHidden + command.length - keep.size;
  if (!hidden) return command;
  return [...command.slice(0, first), `… ${hidden} more lines`, ...command.filter((_, at) => at >= first && keep.has(at))];
}
