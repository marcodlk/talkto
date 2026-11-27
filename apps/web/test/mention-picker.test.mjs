import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createVite } from "vite";

/*
  The channel composer's @mention picker: which typed tokens open it, which participants it offers
  and in what order, what picking writes, and how the keyboard moves through it.
*/

const load = async (t, path) => {
  const vite = await createVite({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  t.after(() => vite.close());
  return vite.ssrLoadModule(path);
};

/** `value` with `|` marking the caret, as mentionAt sees it. */
const at = (mentionAt, marked) => mentionAt(marked.replace("|", ""), marked.indexOf("|"));

test("a mention opens only where the server would read one", async (t) => {
  const { mentionAt } = await load(t, "/src/mention-picker.ts");
  assert.deepEqual(at(mentionAt, "@|"), { start: 0, end: 1, text: "" });
  assert.deepEqual(at(mentionAt, "@Ced|"), { start: 0, end: 4, text: "Ced" });
  assert.deepEqual(at(mentionAt, "please ask @rel| now"), { start: 11, end: 15, text: "rel" });
  assert.deepEqual(at(mentionAt, "first line\n@at|"), { start: 11, end: 14, text: "at" });
  assert.deepEqual(at(mentionAt, "(@ced|"), { start: 1, end: 5, text: "ced" });
  assert.deepEqual(at(mentionAt, 'say "@ced|'), { start: 5, end: 9, text: "ced" });
  assert.deepEqual(at(mentionAt, "@platform-api_re|"), {
    start: 0,
    end: 16,
    text: "platform-api_re",
  });
  // An address, a path or a word before the `@` is not a mention.
  assert.equal(at(mentionAt, "a@b|"), null);
  assert.equal(at(mentionAt, "mail ana@example|"), null);
  assert.equal(at(mentionAt, "pkg/@scope|"), null);
  // The caret inside a longer word edits that word; it does not start a mention.
  assert.equal(at(mentionAt, "@Ce|dar"), null);
  assert.equal(at(mentionAt, "hel|lo"), null);
  // Whitespace after the token, or a character no name has, ends it.
  assert.equal(at(mentionAt, "@Cedar |"), null);
  assert.equal(at(mentionAt, "@ |"), null);
  assert.equal(at(mentionAt, "@Cedar.|"), null);
  // Names start with a letter.
  assert.equal(at(mentionAt, "@1|"), null);
  // Code is quoted text: the server reads no mentions there.
  assert.equal(at(mentionAt, "run `x @ce|"), null);
  assert.equal(at(mentionAt, "```\n@ce|"), null);
  assert.deepEqual(at(mentionAt, "`x` @ce|"), { start: 4, end: 7, text: "ce" });
});

test("names that start with the text come first, without the person or removed agents", async (t) => {
  const { matchMembers } = await load(t, "/src/mention-picker.ts");
  const people = [
    { id: "p1", name: "Atlas" },
    { id: "p2", name: "release-bot" },
    { id: "p3", name: "Relay" },
    { id: "p4", name: "Morel", kind: "person" },
    { id: "p5", name: "Rel-old", removedAt: "2026-11-20T00:00:00.000Z" },
    { id: "p6", name: "reLic" },
    { id: "me", name: "Rel", kind: "person" },
  ];
  const names = (list) => list.map((item) => item.name);
  assert.deepEqual(names(matchMembers(people, "REL", "me")), [
    "release-bot",
    "Relay",
    "reLic",
    "Morel",
  ]);
  assert.deepEqual(names(matchMembers(people, "", "me")), [
    "Atlas",
    "release-bot",
    "Relay",
    "Morel",
    "reLic",
  ]);
  assert.deepEqual(names(matchMembers(people, "rel", "me", 2)), ["release-bot", "Relay"]);
  assert.deepEqual(names(matchMembers(people, "rel", null)), [
    "release-bot",
    "Relay",
    "reLic",
    "Rel",
    "Morel",
  ]);
  assert.deepEqual(matchMembers(people, "zz", "me"), []);
});

test("picking writes @name and one space, with the caret after it", async (t) => {
  const { insertMention, mentionAt } = await load(t, "/src/mention-picker.ts");
  const pick = (marked, name) => {
    const value = marked.replace("|", "");
    const query = at(mentionAt, marked);
    const result = insertMention(value, query, name);
    return result.value.slice(0, result.caret) + "|" + result.value.slice(result.caret);
  };
  assert.equal(pick("@ced|", "Cedar"), "@Cedar |");
  assert.equal(
    pick("hi @at| and more", "Atlas"),
    "hi @Atlas |and more",
    "a space already there is reused",
  );
  assert.equal(pick("hi @|", "Atlas"), "hi @Atlas |");
  assert.equal(pick("line\n(@r|)", "Rowan"), "line\n(@Rowan |)");
});

test("the picker moves, wraps, picks and stays dismissed on the same token", async (t) => {
  const { closedPicker, pickerStep } = await load(t, "/src/mention-picker.ts");
  const run = (events, from = closedPicker) => events.reduce(pickerStep, from);
  const query = (start, text) => ({ start, end: start + 1 + text.length, text });
  const typed = run([{ type: "input", query: query(4, "") }]);
  assert.deepEqual(typed, { kind: "open", query: query(4, ""), active: 0 });
  const down = (count = 3) => ({ type: "move", by: 1, count });
  const up = (count = 3) => ({ type: "move", by: -1, count });
  assert.equal(run([down(), down()], typed).active, 2);
  assert.equal(run([down(), down(), down()], typed).active, 0, "ArrowDown wraps to the first");
  assert.equal(run([up()], typed).active, 2, "ArrowUp wraps to the last");
  assert.equal(run([{ type: "hover", index: 1 }], typed).active, 1);
  // A caret event on the same token keeps the active option; more text starts at the top.
  const second = run([down()], typed);
  assert.equal(run([{ type: "input", query: query(4, "") }], second).active, 1);
  assert.equal(run([{ type: "input", query: query(4, "a") }], second).active, 0);
  assert.deepEqual(run([{ type: "pick" }], second), closedPicker);
  assert.deepEqual(run([{ type: "input", query: null }], second), closedPicker);
  // Escape keeps it shut while the same token grows, until another token starts.
  const dismissed = run([{ type: "dismiss" }], typed);
  assert.equal(dismissed.kind, "dismissed");
  assert.equal(run([{ type: "input", query: query(4, "ce") }], dismissed).kind, "dismissed");
  assert.equal(
    run([{ type: "input", query: query(4, "ce") }, down()], dismissed).kind,
    "dismissed",
  );
  assert.equal(run([{ type: "input", query: query(12, "") }], dismissed).kind, "open");
  assert.equal(
    run(
      [
        { type: "input", query: null },
        { type: "input", query: query(4, "") },
      ],
      dismissed,
    ).kind,
    "open",
    "leaving the token and typing a new @ there opens again",
  );
  // Moving with nothing open changes nothing.
  assert.deepEqual(run([down(), up(), { type: "dismiss" }]), closedPicker);
});
