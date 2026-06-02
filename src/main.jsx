import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { LandingPage } from './LandingPage.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { AuthGate } from './auth/AuthGate.jsx';
import { AuthBadge } from './auth/AuthBadge.jsx';
import { CodeGate } from './auth/CodeGate.jsx';
import { ConnectExtensionPage } from './auth/ConnectExtensionPage.jsx';
import { MeetingBotPage } from './MeetingBotPage.jsx';

// Tiny path-based router.
// /                   → LandingPage (marketing)
// /app                → translator tool (AuthGate wrapped)
// /meeting            → Meeting Bot agent console (AuthGate wrapped)
// /connect-extension  → extension pairing page
function Root() {
  const path = window.location.pathname;
  if (path === '/connect-extension') return <ConnectExtensionPage />;
  if (path === '/app' || path === '/app/') {
    return (
      <CodeGate>
        <AuthGate>
          <App />
          <AuthBadge />
        </AuthGate>
      </CodeGate>
    );
  }
  if (path === '/meeting' || path === '/meeting/') {
    return (
      <CodeGate>
        <AuthGate>
          <MeetingBotPage />
          <AuthBadge />
        </AuthGate>
      </CodeGate>
    );
  }
  return <LandingPage />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </React.StrictMode>
);
