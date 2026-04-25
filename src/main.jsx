import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { AuthGate } from './auth/AuthGate.jsx';
import { AuthBadge } from './auth/AuthBadge.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
        <AuthBadge />
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>
);
