import { queryOptions, skipToken } from "@tanstack/react-query";
import { Schema } from "effect";
import * as P from "@talkto/api/platform";
import * as I from "@talkto/api/inputs";
import type * as M from "@talkto/api/models";
import { input, request, type Client } from "./api.js";

/** Reuse the same Home request during route prefetch and visible rendering. */
export function homeQuery(api: Client, userId: P.UserId, accountId: P.AccountId, limit: number) {
  return queryOptions({
    queryKey: ["human", userId, accountId, "home", limit],
    queryFn: ({ signal }) =>
      request(api.platform.dashboard({ params: { accountId }, query: { limit } }), signal),
  });
}

/**
 * The server `serverId` among those the person reaches as an organization member (GET /v1/servers,
 * page by page), or null. A shared link uses it to send a member to the organization's route.
 */
export function memberServerQuery(api: Client, userId: P.UserId, serverId: M.ServerId | null) {
  return queryOptions({
    queryKey: ["human", userId, "member-server", serverId],
    queryFn:
      serverId === null
        ? skipToken
        : async ({ signal }) => {
            let after: string | undefined;
            for (;;) {
              const page = await request(
                api.platform.discoverServers({ query: input(P.Listing, { after }) }),
                signal,
              );
              const found = page.data.items.find((item) => item.id === serverId);
              if (found !== undefined) return found;
              if (page.data.nextCursor === null) return null;
              after = page.data.nextCursor;
            }
          },
  });
}

/** Reuse server context without bypassing the management endpoint's permission checks. */
export function managedServerQuery(
  api: Client,
  userId: P.UserId,
  accountId: P.AccountId,
  serverId: M.ServerId,
) {
  return queryOptions({
    queryKey: ["human", userId, accountId, serverId, "management"],
    queryFn: ({ signal }) =>
      request(api.platform.managedServer({ params: { accountId, serverId } }), signal),
  });
}

/**
 * Organization free-start state, shared by Home's prefetch and every view that shows it. Owners
 * poll it on every organization page, so it keeps the default retry of transient failures: one
 * dropped connection must not end the read.
 */
export function starterQuery(api: Client, userId: P.UserId, accountId: P.AccountId | null) {
  return queryOptions({
    queryKey: ["human", userId, accountId, "starter"],
    queryFn: ({ signal }) =>
      request(
        api.starter.state({
          params: input(Schema.Struct({ accountId: P.AccountId }), { accountId }),
        }),
        signal,
      ),
  });
}

/**
 * A server's active participants, a page of up to 100 in name order, or those whose name, agent
 * type or working directory contains `query`. The composer's @mention picker reads it.
 */
export function participantsQuery(
  api: Client,
  userId: P.UserId,
  accountId: P.AccountId,
  serverId: M.ServerId,
  query?: string,
) {
  return queryOptions({
    queryKey: ["human", userId, accountId, serverId, "participants", query ?? null],
    queryFn: ({ signal }) =>
      request(
        api.server.listParticipants({
          params: { serverId },
          query: input(I.ListParticipants, { query, limit: 100 }),
        }),
        signal,
      ),
  });
}
