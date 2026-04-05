import { useState } from "react";
import { AuthContext, useAuthProvider } from "./hooks/useAuth.js";
import { LoginForm } from "./components/LoginForm.js";
import { RegisterForm } from "./components/RegisterForm.js";
import { Layout } from "./components/Layout.js";
import "./App.css";

/**
 * Root application component.
 *
 * Shows the auth forms when not logged in, and the chat layout when
 * a session is active. The AuthContext provider wraps everything so
 * all components can access auth state via useAuth().
 *
 * The server URL is stored in the auth forms and passed to the Layout.
 * For simplicity, we default to http://127.0.0.1:3000 — this will be
 * configurable per-server in the Docker setup (Phase 10).
 */
function App() {
  const auth = useAuthProvider();
  const [authView, setAuthView] = useState<"login" | "register">("login");

  // Default server URL — matches what the auth forms default to.
  // In production/Docker, this would come from env vars.
  const serverUrl = "http://127.0.0.1:3000";

  return (
    <AuthContext.Provider value={auth}>
      {auth.session ? (
        <Layout serverUrl={serverUrl} />
      ) : (
        <div className="flex items-center justify-center min-h-screen p-4 bg-gray-950">
          {authView === "login" ? (
            <LoginForm onSwitchToRegister={() => setAuthView("register")} />
          ) : (
            <RegisterForm onSwitchToLogin={() => setAuthView("login")} />
          )}
        </div>
      )}
    </AuthContext.Provider>
  );
}

export default App;
