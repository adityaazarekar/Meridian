import React, { useState } from 'react';
import App from './App.jsx';
import Login from './Login.jsx';

export default function AuthWrapper() {
  const [user, setUser] = useState(null);

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <App
      user={user}
      onLogout={() => {
        setUser(null);
      }}
    />
  );
}
