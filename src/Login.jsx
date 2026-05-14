import React, { useState } from 'react';

/** In-memory user store (no browser persistence). */
const memoryUsers = [];

export default function Login({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const P = {
    bg: "#080c14", gold: "#e8b84b", emerald: "#34d399", rose: "#fb7185",
    slate: "#94a3b8", slateD: "#475569", white: "#f1f5f9"
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (isRegister) {
      if (!name.trim()) {
        setError('Name is required for registration.');
        return;
      }
      if (memoryUsers.find(u => u.email === email)) {
        setError('User already exists. Please login.');
        return;
      }
      const newUser = { name, email, password };
      memoryUsers.push(newUser);
      onLogin(newUser);
    } else {
      const user = memoryUsers.find(u => u.email === email && u.password === password);
      if (user) {
        onLogin(user);
      } else {
        setError('Invalid email or password.');
      }
    }
  };

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: P.bg, fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <div style={{ width: '100%', maxWidth: 400, padding: 40, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 16, border: '1px solid rgba(255,255,255,0.09)', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ color: P.gold, margin: '0 0 8px 0', fontSize: 24, letterSpacing: '2px', textTransform: 'uppercase' }}>MERIDIAN</h1>
          <p style={{ color: P.slate, margin: 0, fontSize: 14 }}>Global Analytics Platform</p>
        </div>

        {error && <div style={{ backgroundColor: 'rgba(251, 113, 133, 0.1)', color: P.rose, padding: '12px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20, border: `1px solid ${P.rose}40` }}>{error}</div>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {isRegister && (
            <div>
              <label style={{ display: 'block', color: P.slate, fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '1px' }}>Full Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', backgroundColor: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', padding: '12px 16px', borderRadius: 8, color: P.white, outline: 'none' }} placeholder="John Doe" />
            </div>
          )}

          <div>
            <label style={{ display: 'block', color: P.slate, fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '1px' }}>Email Address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', backgroundColor: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', padding: '12px 16px', borderRadius: 8, color: P.white, outline: 'none' }} placeholder="system@meridian.com" />
          </div>

          <div>
            <label style={{ display: 'block', color: P.slate, fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '1px' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', backgroundColor: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', padding: '12px 16px', borderRadius: 8, color: P.white, outline: 'none' }} placeholder="••••••••" />
          </div>

          <button type="submit" style={{ marginTop: 8, backgroundColor: P.gold, color: P.bg, border: 'none', padding: '14px', borderRadius: 8, fontSize: 14, fontWeight: 'bold', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '1px', transition: 'opacity 0.2s' }} onMouseEnter={e => e.currentTarget.style.opacity = 0.8} onMouseLeave={e => e.currentTarget.style.opacity = 1}>
            {isRegister ? 'Create Account' : 'Authenticate'}
          </button>
        </form>

        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <button onClick={() => { setIsRegister(!isRegister); setError(''); }} style={{ background: 'none', border: 'none', color: P.slate, fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
            {isRegister ? 'Already have an account? Login here.' : 'Need access? Register here.'}
          </button>
        </div>
      </div>
    </div>
  );
}
