import { parseColor, styleText, getTerminalColorMode } from "@earendil-works/pi-tui";

const colorMode = getTerminalColorMode();
const mutedForeground = parseColor("#808080");
const sample = styleText("x", { fg: mutedForeground }, colorMode);
const open = sample.slice(0, sample.indexOf("x"));

/** Explicit muted gray stays visible on dark terminals where ANSI dim is weak. */
export function mutedText(text: string): string {
  const resetAware = text.replace(/\x1b\[(?:0|39)?m/g, (reset) => `${reset}${open}`);
  return styleText(resetAware, { fg: mutedForeground }, colorMode);
}
