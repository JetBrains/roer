/**
 * Calls from an extension's frontend into its own `server.ts`
 * (`docs/extensions.md` §5). The backend starts the server on the first call.
 */
import { useCallback, useEffect, useState } from "react";

import { invoke } from "../lib/backend";
import { useExtensionId } from "./context";

export const rpcCall = <T = unknown>(extension: string, method: string, params?: unknown): Promise<T> =>
  invoke<T>("extension_rpc", { id: extension, method, params: params ?? null });

/** A function that calls this tab's extension's server: for actions, rather than reads. */
export function useCall(): <T = unknown>(method: string, params?: unknown) => Promise<T> {
  const extension = useExtensionId();
  return useCallback(<T,>(method: string, params?: unknown) => rpcCall<T>(extension, method, params), [extension]);
}

export interface RpcState<T> {
  /** The last answer; kept while a reload is under way. */
  data: T | undefined;
  /** What the last call threw, or null. */
  error: string | null;
  loading: boolean;
  /** Calls again. */
  reload(): void;
}

/** Calls `method` with `params` now, again whenever either changes, and on `reload()`. */
export function useRpc<T = unknown>(method: string, params?: unknown): RpcState<T> {
  const extension = useExtensionId();
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true,
  });
  const [round, setRound] = useState(0);
  const key = JSON.stringify(params ?? null);

  useEffect(() => {
    let cancelled = false;
    setState((last) => ({ ...last, loading: true }));
    rpcCall<T>(extension, method, JSON.parse(key)).then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (error: unknown) => !cancelled && setState((last) => ({ data: last.data, error: String(error), loading: false })),
    );
    return () => {
      cancelled = true;
    };
  }, [extension, method, key, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { ...state, reload };
}
