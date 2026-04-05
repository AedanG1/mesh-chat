import { useState, type FormEvent } from "react";
import { useAuth } from "../hooks/useAuth.js";

/**
 * Registration form component.
 *
 * Collects server URL, username, and password, then calls
 * useAuth().register() followed by useAuth().login() to
 * immediately log in the newly registered user.
 *
 * Props:
 *   onSwitchToLogin — callback to switch to the login form
 */
interface RegisterFormProps {
  onSwitchToLogin: () => void;
}

export function RegisterForm({ onSwitchToLogin }: RegisterFormProps) {
  const { register, login, loading, error } = useAuth();

  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:3000");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (password !== confirmPassword) {
      setLocalError("Passwords do not match");
      return;
    }

    try {
      await register(serverUrl, username, password);
      await login(serverUrl, username, password);
    } catch {
      // error is already set in useAuth
    }
  }

  const displayError = localError ?? error;

  return (
    <form
      className="bg-gray-900 border border-gray-700 rounded-lg p-8 w-full max-w-sm flex flex-col gap-4"
      onSubmit={handleSubmit}
    >
      <h2 className="text-center text-xl font-semibold text-gray-100">Register</h2>

      {displayError && (
        <div className="bg-red-900/40 border border-red-800 rounded px-3 py-2 text-sm text-red-400">
          {displayError}
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
          autoComplete="new-password"
          required
          className="px-3 py-2 bg-gray-950 border border-gray-700 rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm text-gray-400">
        Confirm Password
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          required
          className="px-3 py-2 bg-gray-950 border border-gray-700 rounded text-gray-200 text-sm focus:outline-none focus:border-blue-500"
        />
      </label>

      <button
        type="submit"
        disabled={loading}
        className="py-2 bg-green-700 hover:bg-green-600 disabled:opacity-60 disabled:cursor-not-allowed rounded text-white text-sm font-semibold cursor-pointer"
      >
        {loading ? "Creating account..." : "Register"}
      </button>

      <p className="text-center text-xs text-gray-500">
        Already have an account?{" "}
        <button
          type="button"
          onClick={onSwitchToLogin}
          className="text-blue-400 underline cursor-pointer bg-transparent border-none text-xs"
        >
          Login
        </button>
      </p>
    </form>
  );
}
