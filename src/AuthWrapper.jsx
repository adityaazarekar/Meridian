import React from 'react';
import App from './App.jsx';

// Login removed — app loads directly into the dashboard.
const GUEST_USER = { name: 'Guest', email: '' };

export default function AuthWrapper() {
  return <App user={GUEST_USER} onLogout={() => {}} />;
}
