import { useState, type FormEvent } from "react";
import { useAuth } from "../hooks/useAuth.js";

/**
 * Login form component.
 *
 * Collects server URL, username, and password, then calls useAuth().login().
 * Shows loading state and errors inline.
 *
 * Props:
 *   onSwitchToRegister — callback to switch to the registration form
 */
interface LoginFormProps {
  onSwitchToRegister: () => void;
}

export function LoginForm({ onSwitchToRegister }: LoginFormProps) {
  const { login, loading, error } = useAuth();

  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:3000");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await login(serverUrl, username, password);
    } catch {
      // error is already set in useAuth
    }
  }

  return (
    <form
      className="bg-gray-900 border border-gray-700 rounded-lg p-8 w-full max-w-sm flex flex-col gap-4"
      onSubmit={handleSubmit}
    >
      <h2 className="text-center text-xl font-semibold text-gray-100">Login</h2>

      {error && (
        <div className="bg-red-900/40 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Server URL
        <input
          type="text"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="http://127.0.0.1:3000"
          required
          className="px-3 py-2 bg-gray-950 border border-gray-700 rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Username
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          className="px-3 py-2 bg-gray-950 border border-gray-700 rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="px-3 py-2 bg-gray-950 border border-gray-700 rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500"
        />
      </label>

      <button
        type="submit"
        disabled={loading}
        className="py-2 bg-green-700 hover:bg-green-600 disabled:opacity-60 disabled:cursor-not-allowed rounded text-white text-sm font-semibold cursor-pointer"
      >
        {loading ? "Logging in..." : "Login"}
      </button>

      <p className="text-center text-xs text-gray-500">
        Don't have an account?{" "}
        <button
          type="button"
          onClick={onSwitchToRegister}
          className="text-blue-400 underline cursor-pointer bg-transparent border-none text-xs"
        >
          Register
        </button>
      </p>
    </form>
  );
}
