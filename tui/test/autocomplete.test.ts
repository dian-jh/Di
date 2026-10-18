import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { buildAutocompleteEntries } from "../src/app/chat-view.ts";

describe("slash command autocomplete", () => {
  it("offers and accepts the locally handled /usage command", async () => {
    const commands = ["exit", "help", "clear", "model", "skills", "skill"].map((name) => ({
      name, description: name,
    }));
    const entries = buildAutocompleteEntries(commands, [], []);
    const provider = new CombinedAutocompleteProvider(entries, process.cwd());
    const suggestions = await provider.getSuggestions(["/u"], 0, 2, { signal: new AbortController().signal });
    assert.ok(suggestions);
    assert.deepEqual(suggestions.items.map((item) => item.value), ["usage"]);
    const all = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    assert.ok(all);
    assert.deepEqual(all.items.map((item) => item.value).slice(0, 7), ["exit", "help", "clear", "model", "skills", "skill", "usage"]);
    assert.deepEqual(provider.applyCompletion(["/u"], 0, 2, suggestions.items[0]!, suggestions.prefix), {
      lines: ["/usage "], cursorLine: 0, cursorCol: 7,
    });
  });
});
