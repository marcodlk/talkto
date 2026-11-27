import {
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type * as P from "@talkto/api/platform";
import type * as M from "@talkto/api/models";
import { ParticipantMark } from "./components.js";
import { participantsQuery } from "./dashboard-queries.js";
import {
  closedPicker,
  insertMention,
  matchMembers,
  mentionAt,
  pickerStep,
} from "./mention-picker.js";
import { useHuman, useServices } from "./session.js";

/** The participants the picker can offer, read once the person first types `@`. */
function useCandidates(
  accountId: P.AccountId,
  serverId: M.ServerId,
  open: boolean,
  text: string,
): ReadonlyArray<M.Participant> {
  const { api } = useServices();
  const user = useHuman();
  const first = useQuery({
    ...participantsQuery(api, user.id, accountId, serverId),
    enabled: open,
    staleTime: 60_000,
  });
  // A server with more participants than one page also searches for the typed text.
  const more = first.data !== undefined && first.data.data.nextCursor !== null;
  const found = useQuery({
    ...participantsQuery(api, user.id, accountId, serverId, text),
    enabled: open && more && text !== "",
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  return [...(first.data?.data.items ?? []), ...(more ? (found.data?.data.items ?? []) : [])];
}

/**
 * The @mention picker for a channel composer. It reads the textarea's text and caret, owns which
 * option is active, and writes `@<name> ` into the text when the person picks one.
 */
export function useMentionPicker({
  enabled,
  accountId,
  serverId,
  self,
  field,
  text,
  setText,
}: {
  /** False in a direct chat, where the one agent there needs no mention. */
  readonly enabled: boolean;
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly self: M.ParticipantId | null;
  readonly field: RefObject<HTMLTextAreaElement | null>;
  readonly text: string;
  readonly setText: (value: string) => void;
}) {
  const [picker, dispatch] = useReducer(pickerStep, closedPicker);
  const listId = useId();
  const open = enabled && picker.kind === "open";
  const typed = picker.kind === "open" ? picker.query.text : "";
  const candidates = useCandidates(accountId, serverId, open, typed);
  const options = open ? matchMembers(candidates, typed, self) : [];
  const shown = picker.kind === "open" && options.length > 0;
  const active = shown ? Math.min(picker.active, options.length - 1) : -1;
  // The caret to restore once a picked name is in the textarea.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || field.current === null) return;
    field.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text, field]);

  /** Read the textarea's text and caret again, after typing, clicking or moving the caret. */
  const track = (element: HTMLTextAreaElement) => {
    if (!enabled) return;
    const { value, selectionStart, selectionEnd } = element;
    dispatch({
      type: "input",
      query: selectionStart === selectionEnd ? mentionAt(value, selectionStart) : null,
    });
  };
  const pick = (index: number) => {
    const option = options[index];
    if (picker.kind !== "open" || option === undefined) return;
    const next = insertMention(text, picker.query, option.name);
    caret.current = next.caret;
    dispatch({ type: "pick" });
    setText(next.value);
  };
  /** Handles the keys the open picker owns; true when the composer must not act on the key. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!shown || event.nativeEvent.isComposing) return false;
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === "ArrowDown" || event.key === "ArrowUp")
      dispatch({ type: "move", by: event.key === "ArrowDown" ? 1 : -1, count: options.length });
    else if ((event.key === "Enter" || event.key === "Tab") && plain) pick(active);
    else if (event.key === "Escape") dispatch({ type: "dismiss" });
    else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  const optionId = (index: number) => `${listId}-${index}`;
  const textarea = enabled
    ? {
        "aria-autocomplete": "list" as const,
        "aria-expanded": shown,
        "aria-controls": listId,
        "aria-activedescendant": shown ? optionId(active) : undefined,
        onSelect: (event: { readonly currentTarget: HTMLTextAreaElement }) =>
          track(event.currentTarget),
        onKeyUp: (event: { readonly currentTarget: HTMLTextAreaElement }) =>
          track(event.currentTarget),
        onClick: (event: { readonly currentTarget: HTMLTextAreaElement }) =>
          track(event.currentTarget),
        onBlur: () => dispatch({ type: "input", query: null }),
      }
    : {};
  const list = enabled ? (
    <MentionList
      id={listId}
      options={shown ? options : []}
      active={active}
      optionId={optionId}
      onHover={(index) => dispatch({ type: "hover", index })}
      onPick={pick}
    />
  ) : null;
  return { track, onKeyDown, textarea, list };
}

/**
 * The options under a typed `@`: each name with its mark and whether it is an agent or a person.
 * It stays in the page while empty so the textarea's `aria-controls` always names it.
 */
export function MentionList({
  id,
  options,
  active,
  optionId,
  onHover,
  onPick,
}: {
  readonly id: string;
  readonly options: ReadonlyArray<M.Participant>;
  readonly active: number;
  readonly optionId: (index: number) => string;
  readonly onHover: (index: number) => void;
  readonly onPick: (index: number) => void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Mention"
      className="ops-mention-list"
      hidden={options.length === 0}
    >
      {options.map((option, index) => (
        <li
          key={option.id}
          id={optionId(index)}
          role="option"
          aria-selected={index === active}
          onMouseEnter={() => onHover(index)}
          // Picking on mousedown, without the default, keeps focus in the textarea.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(index);
          }}
        >
          <span className="ops-mention-mark" aria-hidden="true">
            <ParticipantMark participant={option} />
          </span>
          <span className="ops-mention-name">{option.name}</span>
          <small>{option.kind === "person" ? "person" : "agent"}</small>
        </li>
      ))}
    </ul>
  );
}
