import { useState } from 'react'
import { authLogin, authRegister } from '../utils/api'

/* ── AuthModal ───────────────────────────────────────────────────────────────
   Shows login / register tabs.
   Props:
     onSuccess(user)   called after successful auth
     onClose()         called when user dismisses
*/
export default function AuthModal({ onSuccess, onClose }) {
  const [tab,     setTab]     = useState('login')  // 'login' | 'register'
  const [email,   setEmail]   = useState('')
  const [name,    setName]    = useState('')
  const [pass,    setPass]    = useState('')
  const [pass2,   setPass2]   = useState('')
  const [error,   setError]   = useState(null)
  const [loading, setLoading] = useState(false)

  const clear = () => { setError(null) }

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    if (tab === 'register') {
      if (pass !== pass2)    return setError('Passwords do not match')
      if (pass.length < 8)   return setError('Password must be at least 8 characters')
    }

    setLoading(true)
    try {
      const user = tab === 'login'
        ? await authLogin(email.trim(), pass)
        : await authRegister(email.trim(), pass, name.trim() || undefined)
      onSuccess(user)
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="auth-modal">

        <div className="auth-header">
          <div className="auth-title-row">
            <span className="auth-icon">☁</span>
            <h2>{tab === 'login' ? 'Log in' : 'Create account'}</h2>
          </div>
          <p className="auth-sub">
            {tab === 'login'
              ? 'Access your saved layouts from any device.'
              : 'Your existing layouts will be merged into your account.'}
          </p>
          <div className="auth-tabs">
            <button className={`auth-tab ${tab === 'login'    ? 'active' : ''}`} onClick={() => { setTab('login');    clear() }}>Log in</button>
            <button className={`auth-tab ${tab === 'register' ? 'active' : ''}`} onClick={() => { setTab('register'); clear() }}>Create account</button>
          </div>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {tab === 'register' && (
            <label className="auth-field">
              <span>Name (optional)</span>
              <input
                type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Your name" autoComplete="name"
              />
            </label>
          )}

          <label className="auth-field">
            <span>Email</span>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" autoComplete="email" required
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password" value={pass} onChange={e => setPass(e.target.value)}
              placeholder="••••••••" autoComplete={tab === 'login' ? 'current-password' : 'new-password'} required
            />
          </label>

          {tab === 'register' && (
            <label className="auth-field">
              <span>Confirm password</span>
              <input
                type="password" value={pass2} onChange={e => setPass2(e.target.value)}
                placeholder="••••••••" autoComplete="new-password" required
              />
            </label>
          )}

          {error && <p className="auth-error">{error}</p>}

          <div className="auth-footer">
            <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? '…' : tab === 'login' ? 'Log in' : 'Create account'}
            </button>
          </div>
        </form>

        <p className="auth-device-note">
          No account needed — your layouts are already saved on this device.
        </p>
      </div>
    </div>
  )
}

/* ── UserBadge ────────────────────────────────────────────────────────────────
   Small header button: shows avatar if logged in, "Log in" if not.
*/
export function UserBadge({ user, onLoginClick, onLogout }) {
  if (user) {
    const initials = (user.display_name || user.email).slice(0, 2).toUpperCase()
    return (
      <div className="user-badge">
        <div className="user-avatar" title={user.display_name || user.email}>{initials}</div>
        <button className="user-logout" onClick={onLogout} title="Log out">↩</button>
      </div>
    )
  }
  return (
    <div className="user-login-wrap">
      <span className="user-login-hint">save &amp; access across devices</span>
      <button className="btn btn-ghost btn-sm user-login-btn" onClick={onLoginClick}>
        ☁ Log in
      </button>
    </div>
  )
}
