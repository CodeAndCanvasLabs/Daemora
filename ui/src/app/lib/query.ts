/**
 * React Query setup — server state for the rebuilt UI.
 *
 * Replaces the old per-page useState + manual refetch pattern (the source of the
 * state-sync / stale-data bugs). Pages subscribe to typed hooks; mutations do
 * optimistic updates and the cache is the single source of truth on the client.
 *
 * Wire <QueryClientProvider client={queryClient}> once at the app root (shell).
 */

import { QueryClient, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { configApi, sessionsApi, type ConfigMap } from "./api-client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export const qk = {
  config: ["config"] as const,
  sessions: ["sessions"] as const,
  activeSession: ["active-session"] as const,
};

/** All chats, most-recently-updated first. */
export function useSessions() {
  return useQuery({ queryKey: qk.sessions, queryFn: sessionsApi.list });
}

/** Which chat is active (inbound channel messages route there). */
export function useActiveSession() {
  return useQuery({ queryKey: qk.activeSession, queryFn: sessionsApi.getActive });
}

/** Mark a chat as the active one. */
export function useSetActiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => sessionsApi.setActive(sessionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.activeSession }),
  });
}

/** Create a new chat. */
export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) => sessionsApi.create(title),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

/** Delete a whole chat. */
export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sessions }),
  });
}

/** The user's central config (Postgres source of truth). */
export function useConfig() {
  return useQuery({ queryKey: qk.config, queryFn: configApi.get });
}

/** Save a partial config patch through the ONE endpoint, optimistically. */
export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ConfigMap) => configApi.update(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.config });
      const prev = qc.getQueryData<ConfigMap>(qk.config);
      qc.setQueryData<ConfigMap>(qk.config, { ...(prev ?? {}), ...patch });
      return { prev };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.config, ctx.prev);
    },
    onSuccess: (config) => qc.setQueryData(qk.config, config),
  });
}
