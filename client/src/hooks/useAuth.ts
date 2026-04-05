import { createContext, useContext, useState, useCallback, useRef } from "react";
import { AuthStore, type Session } from "../store/AuthStore.js";

/**
 * The shape of the auth context that components consume.
 *
 * Components never touch AuthStore directly — they call these functions
 * and read the state. The hook manages the AuthStore instance internally.
 */
export interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  error: string | null;
  register: (serverUrl: string, username: string, password: string) => Promise<void>;
  login: (serverUrl: string, username: string, password: string) => Promise<void>;
  logout: () => void;
}

/**
 * React Context for auth state. Created here, provided in App.tsx.
 * The default value is never used — it's overridden by the provider.
 */
export const AuthContext = createContext<AuthContextValue>(null!);

/**
 * Hook that components call to access auth state and actions.
 * Must be used inside an AuthContext.Provider.
 */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/**
 * Hook that creates and manages the AuthStore instance.
 * Called once in App.tsx to create the context value.
 *
 * Why a separate "provider" hook?
 *   useAuth() is for consumers (read state, call actions).
 *   useAuthProvider() is for the single provider (owns the store).
 *   This keeps the store as a singleton and avoids re-creating it.
 */
export function useAuthProvider(): AuthContextValue {
  const storeRef = useRef(new AuthStore());
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = useCallback(async (serverUrl: string, username: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      await storeRef.current.register(serverUrl, username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (serverUrl: string, username: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const sess = await storeRef.current.login(serverUrl, username, password);
      setSession(sess);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    storeRef.current.logout();
    setSession(null);
    setError(null);
  }, []);

  return { session, loading, error, register, login, logout };
}
