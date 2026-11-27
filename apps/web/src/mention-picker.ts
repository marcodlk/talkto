import type * as M from "@talkto/api/models";

/*
  The @mention picker's rules, apart from React. The server tags a channel message's participants
  by exact current name, ignoring case (apps/server/src/mentions.ts), so picking only has to write
  `@<name> `. A token opens the picker only where the server would read it as a mention.
*/

/** The `@token` being typed: `start` is the `@`, `end` the caret, `text` what lies between. */
export type MentionQuery = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

/** Characters a participant name continues with (models.ts `Name`: a letter, then these). */
const nameChar = /[A-Za-z0-9_-]/;
/** A name in progress: empty, or a letter then name characters, up to a name's 64. */
const partialName = /^(?:[A-Za-z][A-Za-z0-9_-]{0,63})?$/;
/** Where a mention may start: after whitespace or an opening bracket or quote. */
const opener = /[\s([{<"'“‘]/;

/** True when `index` lies inside Markdown code, where the server reads no mentions. */
const inCode = (value: string, index: number): boolean => {
  const before = value.slice(0, index);
  if ((before.match(/```/g) ?? []).length % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf("\n") + 1).replaceAll("```", "");
  return (line.match(/`/g) ?? []).length % 2 === 1;
};

/**
 * The mention being typed at `caret`, or null. The `@` must start the text or follow whitespace or
 * an opening bracket or quote (so `ana@example.com` is not one), only name characters may lie
 * between it and the caret, and the caret must not sit inside a longer word.
 */
export const mentionAt = (value: string, caret: number): MentionQuery | null => {
  if (caret < 0 || caret > value.length) return null;
  if (caret < value.length && nameChar.test(value.charAt(caret))) return null;
  let start = caret - 1;
  while (start >= 0 && nameChar.test(value.charAt(start))) start--;
  if (start < 0 || value.charAt(start) !== "@") return null;
  if (start > 0 && !opener.test(value.charAt(start - 1))) return null;
  const text = value.slice(start + 1, caret);
  if (!partialName.test(text) || inCode(value, start)) return null;
  return { start, end: caret, text };
};

/** Who can be mentioned: anyone the server tags by name, agents and people alike. */
export type Candidate = Pick<M.Participant, "id" | "name" | "kind" | "removedAt">;

/**
 * Up to `limit` participants whose names contain `text`, ignoring case: names that start with it
 * first, then the rest, each group in the order given. The person's own participant (`self`) and
 * removed agents, which a mention cannot reach, are left out.
 */
export const matchMembers = <C extends Candidate>(
  candidates: ReadonlyArray<C>,
  text: string,
  self: M.ParticipantId | null,
  limit = 6,
): ReadonlyArray<C> => {
  const wanted = text.toLowerCase();
  const prefix: C[] = [];
  const inner: C[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.id === self || candidate.removedAt !== undefined || seen.has(candidate.id))
      continue;
    seen.add(candidate.id);
    const at = candidate.name.toLowerCase().indexOf(wanted);
    if (at === 0) prefix.push(candidate);
    else if (at > 0) inner.push(candidate);
  }
  return [...prefix, ...inner].slice(0, limit);
};

/** A composer's text with the caret where it belongs. */
export type Edit = { readonly value: string; readonly caret: number };

/**
 * `value` with the typed `@text` replaced by `@name ` and the caret just after it. When a space
 * already follows the token, it is reused instead of doubled.
 */
export const insertMention = (value: string, query: MentionQuery, name: string): Edit => {
  const rest = value.slice(query.end);
  const spaced = /^\s/.test(rest);
  const head = `${value.slice(0, query.start)}@${name}${spaced ? "" : " "}`;
  return { value: head + rest, caret: head.length + (spaced ? 1 : 0) };
};

/**
 * The picker: closed, open on a query with one option active, or dismissed with Escape. A dismissed
 * picker stays shut while the person keeps typing the same token, and opens again on a new one.
 */
export type Picker =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly query: MentionQuery; readonly active: number }
  | { readonly kind: "dismissed"; readonly start: number };

export type PickerEvent =
  /** The text or caret changed; `query` is `mentionAt` there. */
  | { readonly type: "input"; readonly query: MentionQuery | null }
  /** ArrowDown (+1) or ArrowUp (-1) among `count` options, wrapping at the ends. */
  | { readonly type: "move"; readonly by: 1 | -1; readonly count: number }
  /** The pointer is over an option. */
  | { readonly type: "hover"; readonly index: number }
  | { readonly type: "pick" }
  | { readonly type: "dismiss" };

export const closedPicker: Picker = { kind: "closed" };

export const pickerStep = (state: Picker, event: PickerEvent): Picker => {
  switch (event.type) {
    case "input": {
      const query = event.query;
      if (query === null) return closedPicker;
      if (state.kind === "dismissed" && state.start === query.start) return state;
      // The same token with the same text (a caret event) keeps the active option.
      const active =
        state.kind === "open" &&
        state.query.start === query.start &&
        state.query.text === query.text
          ? state.active
          : 0;
      return { kind: "open", query, active };
    }
    case "move":
      if (state.kind !== "open" || event.count <= 0) return state;
      return {
        ...state,
        active: (((state.active + event.by) % event.count) + event.count) % event.count,
      };
    case "hover":
      return state.kind === "open" ? { ...state, active: event.index } : state;
    case "pick":
      return closedPicker;
    case "dismiss":
      return state.kind === "open" ? { kind: "dismissed", start: state.query.start } : state;
  }
};
