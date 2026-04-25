import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { AuthGate } from './auth/AuthGate.jsx';
import { AuthBadge } from './auth/AuthBadge.jsx';
import { ConnectExtensionPage } from './auth/ConnectExtensionPage.jsx';

// Tiny path-based router. Webapp is otherwise a single-page tool, so this
// replaces a real router for one extra route.
function Root() {
  const path = window.location.pathname;
  if (path === '/connect-extension') return <ConnectExtensionPage />;
  return (
    <AuthGate>
      <App />
      <AuthBadge />
    </AuthGate>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </React.StrictMode>
);
