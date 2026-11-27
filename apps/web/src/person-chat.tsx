import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import type * as P from "@talkto/api/platform";
import * as M from "@talkto/api/models";
import { ApiError, request } from "./api.js";
import { PersonMark } from "./components.js";
import { useMentionPicker } from "./mention-list.js";
import { useHuman, useServices } from "./session.js";
import { useServerPath } from "./server-path.js";
import "./person-chat.css";

/*
  Messages from people. The server derives the sender from the signed-in session, so the browser
  never names a participant when it sends. It asks the server which participant is this person's
  own on a server (`GET people/me`), only to know which direct chats get a composer, and whether
  the server takes their channel posts (`postsInChannels`, absent on servers from before November
  15, 2026, which keep channels read-only). That ID is not a credential: sending into anyone
  else's chat is refused by the server.
*/

/** The conversation on screen and the participants its authorized read included. */
export interface Selected {
  readonly conversation: M.Conversation;
  readonly participants: ReadonlyArray<M.Participant>;
}
/** Provided by the conversation view, so the message log beneath it can offer the right footer. */
export const SelectedConversation = createContext<Selected | null>(null);

const personKey = (
  user: string,
  accountId: P.AccountId,
  serverId: M.ServerId | undefined,
): ReadonlyArray<string | undefined> => ["human", user, accountId, serverId, "person"];

/**
 * What the server says about the signed-in person here: their own participant (null before they
 * first take part) and whether they may post in channels. Asked only while a conversation is on
 * screen; it changes only when the person opens a chat or first posts in a channel.
 */
export function usePersonSelf(
  accountId: P.AccountId,
  serverId: M.ServerId | undefined,
  enabled: boolean,
): M.PersonSelf | undefined {
  const { api } = useServices();
  const user = useHuman();
  const result = useQuery({
    queryKey: personKey(user.id, accountId, serverId),
    queryFn:
      enabled && serverId !== undefined
        ? ({ signal }) => request(api.server.getPersonSelf({ params: { serverId } }), signal)
        : skipToken,
    staleTime: 5 * 60_000,
  });
  return result.data?.data;
}

/** The signed-in person's own participant on this server, or null before they first take part. */
export function usePersonId(
  accountId: P.AccountId,
  serverId: M.ServerId | undefined,
  enabled: boolean,
): M.ParticipantId | null {
  return usePersonSelf(accountId, serverId, enabled)?.participant?.id ?? null;
}

/** Open, or reopen, the person's own chat with an agent, and go to it. */
export function useMessageAgent(accountId: P.AccountId, serverId: M.ServerId) {
  const { api } = useServices();
  const path = useServerPath(accountId, serverId);
  const user = useHuman();
  const navigate = useNavigate();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (agent: M.Participant) =>
      request(
        api.server.openPersonDirectChat({
          params: { serverId },
          payload: { agentId: agent.id, requestKey: M.RequestKey.make(crypto.randomUUID()) },
        }),
      ),
    onSuccess: (result) => {
      const chat = result.data.item;
      // The first chat creates the person's participant; ask the server for it again.
      void cache.invalidateQueries({ queryKey: personKey(user.id, accountId, serverId) });
      cache.setQueryData(["human", user.id, accountId, serverId, "conversation", chat.id], {
        ...result,
        data: chat,
      });
      void navigate({
        to: "/app/$",
        params: { _splat: path },
        search: { tab: "directs", channel: chat.id },
      });
    },
  });
}

/** "Message" on an agent: opens the person's chat with it. A person has no such action. */
export function MessageAgent({
  accountId,
  serverId,
  agent,
  label = "Message",
  className = "text-button ops-message-agent",
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly agent: M.Participant;
  readonly label?: string;
  readonly className?: string;
}) {
  const open = useMessageAgent(accountId, serverId);
  // A removed agent cannot receive messages until a person restores it.
  if (agent.kind === "person" || agent.removedAt !== undefined) return null;
  return (
    <span className="ops-message-agent-action">
      <button
        type="button"
        className={className}
        aria-label={label === "Message" ? `Message ${agent.name}` : undefined}
        disabled={open.isPending}
        onClick={(event) => {
          event.stopPropagation();
          open.mutate(agent);
        }}
      >
        {open.isPending ? "Opening…" : label}
      </button>
      {open.error && (
        <small className="ops-message-agent-error" role="alert">
          {open.error instanceof ApiError ? open.error.message : "The chat could not be opened."}
        </small>
      )}
    </span>
  );
}

interface Outgoing {
  readonly requestKey: M.RequestKey;
  readonly body: typeof M.MessageBody.Type;
  readonly urgent: boolean;
  readonly state: "sending" | "sent" | "failed";
  readonly messageId: M.MessageId | null;
  readonly error: string | null;
}

/** Where the composer sends: the person's own chat with an agent, or a channel. */
export type ComposerTarget =
  | { readonly kind: "direct"; readonly agent: M.Participant }
  | {
      readonly kind: "channel";
      readonly name: M.Name;
      /** The person's own participant, or null until their first post here creates it. */
      readonly self: M.Participant | null;
    };

/**
 * The person's composer, in their own chat with an agent or in a channel, where they post as
 * themselves. Enter sends and Shift+Enter starts a new line. A send that fails stays below the
 * conversation with Retry, which reuses its request key, so a send that did arrive is never posted
 * twice.
 */
export function PersonComposer({
  accountId,
  serverId,
  conversationId,
  target,
  delivered,
  onSent,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  readonly conversationId: M.ConversationId;
  readonly target: ComposerTarget;
  /** Message IDs the conversation already shows; a sent message leaves the outbox once there. */
  readonly delivered: ReadonlySet<string>;
  readonly onSent: () => void;
}) {
  const { api } = useServices();
  const user = useHuman();
  const cache = useQueryClient();
  const label =
    target.kind === "direct" ? `Message ${target.agent.name}` : `Message #${target.name}`;
  // A first channel post needs the person's own participant, which the server names from the
  // sign-in. Joining is idempotent, so a retry after a failed send is safe.
  const join = async () => {
    if (target.kind !== "channel" || target.self !== null) return;
    await request(api.server.joinAsPerson({ params: { serverId } }));
    void cache.invalidateQueries({ queryKey: personKey(user.id, accountId, serverId) });
  };
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<ReadonlyArray<Outgoing>>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const hint = useId();
  const mention = useMentionPicker({
    enabled: target.kind === "channel",
    accountId,
    serverId,
    self: target.kind === "channel" ? (target.self?.id ?? null) : null,
    field,
    text,
    setText,
  });
  const update = (key: M.RequestKey, change: Partial<Outgoing>) =>
    setOutbox((items) =>
      items.map((item) => (item.requestKey === key ? { ...item, ...change } : item)),
    );
  const send = useMutation({
    mutationFn: async (item: Outgoing) => {
      await join();
      return request(
        api.server.sendPersonMessage({
          params: { serverId },
          payload: item.urgent
            ? { conversationId, requestKey: item.requestKey, body: item.body, priority: "urgent" }
            : { conversationId, requestKey: item.requestKey, body: item.body },
        }),
      );
    },
    onMutate: (item) => update(item.requestKey, { state: "sending", error: null }),
    onSuccess: (result, item) => {
      update(item.requestKey, { state: "sent", messageId: result.data.item.id });
      onSent();
    },
    onError: (error, item) =>
      update(item.requestKey, {
        state: "failed",
        error: error instanceof ApiError ? error.message : "The message could not be sent.",
      }),
  });
  // A sent message leaves the outbox as soon as the conversation shows it.
  useEffect(() => {
    setOutbox((items) => {
      const kept = items.filter(
        (item) => item.messageId === null || !delivered.has(item.messageId),
      );
      return kept.length === items.length ? items : kept;
    });
  }, [delivered]);
  const submit = () => {
    const body = Schema.decodeUnknownOption(M.MessageBody)(text.trim());
    if (Option.isNone(body)) {
      setInvalid(
        text.trim() === ""
          ? "Write a message first."
          : "This message is too long. Messages hold up to 16 KB of text.",
      );
      return;
    }
    setInvalid(null);
    const item: Outgoing = {
      requestKey: M.RequestKey.make(crypto.randomUUID()),
      body: body.value,
      urgent: target.kind === "direct" && urgent,
      state: "sending",
      messageId: null,
      error: null,
    };
    setOutbox((items) => [...items, item]);
    setText("");
    setUrgent(false);
    send.mutate(item);
    field.current?.focus();
  };
  return (
    <div className="ops-composer-region">
      {outbox.length > 0 && (
        <ol className="ops-outbox" aria-label="Messages you are sending">
          {outbox.map((item) => (
            <li key={item.requestKey} data-state={item.state}>
              <p>{item.body}</p>
              <small role={item.state === "failed" ? "alert" : "status"}>
                {item.urgent && <span className="ops-urgent-tag">Urgent</span>}
                {item.state === "sending"
                  ? "Sending…"
                  : item.state === "sent"
                    ? "Sent"
                    : `Not sent. ${item.error ?? ""}`}
                {item.state === "failed" && (
                  <>
                    <button type="button" className="text-button" onClick={() => send.mutate(item)}>
                      Retry
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setOutbox((items) =>
                          items.filter((entry) => entry.requestKey !== item.requestKey),
                        )
                      }
                    >
                      Discard
                    </button>
                  </>
                )}
              </small>
            </li>
          ))}
        </ol>
      )}
      <form
        className="ops-composer"
        aria-label={label}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={field}
          rows={2}
          value={text}
          placeholder={label}
          aria-label={label}
          aria-describedby={hint}
          aria-invalid={invalid !== null || undefined}
          {...mention.textarea}
          onChange={(event) => {
            setText(event.target.value);
            mention.track(event.target);
            if (invalid) setInvalid(null);
          }}
          onKeyDown={(event) => {
            if (mention.onKeyDown(event)) return;
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        {mention.list}
        <div className="ops-composer-bar">
          {target.kind === "direct" ? (
            <label
              className="ops-composer-urgent"
              title="Puts the message into the agent's running turn"
            >
              <input
                type="checkbox"
                checked={urgent}
                onChange={(event) => setUrgent(event.target.checked)}
              />
              Urgent
            </label>
          ) : (
            <span className="ops-composer-identity">
              {target.self === null ? (
                "You post as yourself"
              ) : (
                <>
                  You post as <PersonMark name={target.self.name} />
                  <strong>{target.self.name}</strong>
                </>
              )}
            </span>
          )}
          <small id={hint} className="ops-composer-hint">
            {invalid ?? "Enter sends · Shift+Enter for a new line"}
          </small>
          <button type="submit" className="ops-new primary ops-composer-send">
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Under the conversation: the composer in the person's own chat with an agent and in channels the
 * server lets them post in, and everywhere else a read-only note with a shortcut to message the
 * agents in it.
 */
export function ConversationFooter({
  accountId,
  serverId,
  senders,
  delivered,
  onSent,
}: {
  readonly accountId: P.AccountId;
  readonly serverId: M.ServerId;
  /** Recent senders in the loaded messages, newest first, for a channel's shortcuts. */
  readonly senders: ReadonlyArray<M.Participant>;
  readonly delivered: ReadonlySet<string>;
  readonly onSent: () => void;
}): ReactNode {
  const selected = useContext(SelectedConversation);
  const person = usePersonSelf(accountId, serverId, selected !== null);
  const me = person?.participant?.id ?? null;
  if (!selected) return null;
  const { conversation, participants } = selected;
  const members =
    conversation.kind === "direct"
      ? conversation.participantIds.flatMap((id) => participants.filter((p) => p.id === id))
      : [];
  const agents = members.filter((participant) => participant.kind !== "person");
  const [agent] = agents;
  if (conversation.kind === "direct" && me !== null && conversation.participantIds.includes(me)) {
    if (agent === undefined) return null;
    return (
      <PersonComposer
        key={conversation.id}
        accountId={accountId}
        serverId={serverId}
        conversationId={conversation.id}
        target={{ kind: "direct", agent }}
        delivered={delivered}
        onSent={onSent}
      />
    );
  }
  // Servers from before November 15, 2026 do not say postsInChannels; channels stay read-only.
  if (
    conversation.kind === "channel" &&
    conversation.archivedAt === null &&
    person?.postsInChannels
  )
    return (
      <PersonComposer
        key={conversation.id}
        accountId={accountId}
        serverId={serverId}
        conversationId={conversation.id}
        target={{
          kind: "channel",
          name: conversation.name,
          self: person.participant,
        }}
        delivered={delivered}
        onSent={onSent}
      />
    );
  const shortcuts = (conversation.kind === "direct" ? agents : senders)
    .filter((participant) => participant.kind !== "person")
    .slice(0, 3);
  return (
    <div className="ops-readonly-footer">
      <p>
        {conversation.kind === "channel"
          ? conversation.archivedAt !== null
            ? "This channel is archived, so it takes no new messages."
            : "Channels are read-only here."
          : members.length === agents.length
            ? "This chat is between agents; it is read-only here."
            : "Only its two participants can write in this chat."}
      </p>
      {shortcuts.map((participant) => (
        <MessageAgent
          key={participant.id}
          accountId={accountId}
          serverId={serverId}
          agent={participant}
          label={`Message ${participant.name}`}
          className="ops-new"
        />
      ))}
    </div>
  );
}
