import { useState, useRef, useEffect } from 'react'
import { authLogin, authRegister, authForgotPassword, authResetPassword } from '../utils/api'

/* ── AuthModal ───────────────────────────────────────────────────────────────
   Views: 'login' | 'register' | 'forgot' | 'reset'
   Props:
     onSuccess(user)   called after successful auth
     onClose()         called when user dismisses
     resetToken        if present, opens directly to reset-password view
*/
export default function AuthModal({ onSuccess, onClose, resetToken = null }) {
  const [view,    setView]    = useState(resetToken ? 'reset' : 'login')
  const [email,   setEmail]   = useState('')
  const [name,    setName]    = useState('')
  const [pass,    setPass]    = useState('')
  const [pass2,   setPass2]   = useState('')
  const [error,   setError]   = useState(null)
  const [info,    setInfo]    = useState(null)
  const [loading, setLoading] = useState(false)

  const clearMessages = () => { setError(null); setInfo(null) }
  const switchView = (v) => { clearMessages(); setPass(''); setPass2(''); setView(v) }

  /* ── Login / Register ── */
  const submitAuth = async (e) => {
    e.preventDefault()
    clearMessages()
    if (view === 'register') {
      if (pass !== pass2)  return setError('Passwords do not match')
      if (pass.length < 8) return setError('Password must be at least 8 characters')
    }
    setLoading(true)
    try {
      const user = view === 'login'
        ? await authLogin(email.trim(), pass)
        : await authRegister(email.trim(), pass, name.trim() || undefined)
      onSuccess(user)
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  /* ── Forgot password ── */
  const submitForgot = async (e) => {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      await authForgotPassword(email.trim())
      setInfo('If that email is registered, a reset link has been sent. Check your inbox.')
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  /* ── Reset password ── */
  const submitReset = async (e) => {
    e.preventDefault()
    clearMessages()
    if (pass !== pass2)  return setError('Passwords do not match')
    if (pass.length < 8) return setError('Password must be at least 8 characters')
    setLoading(true)
    try {
      const user = await authResetPassword(resetToken, pass)
      onSuccess(user)
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const title = { login: 'Log in', register: 'Create account', forgot: 'Reset password', reset: 'Set new password' }

  return (
    <div className="auth-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="auth-modal">

        <div className="auth-header">
          <div className="auth-title-row">
            <span className="auth-icon">☁</span>
            <h2>{title[view]}</h2>
          </div>

          {(view === 'login' || view === 'register') && (
            <>
              <p className="auth-sub">
                {view === 'login'
                  ? 'Access your saved layouts from any device.'
                  : 'Your existing layouts will be merged into your account.'}
              </p>
              <div className="auth-tabs">
                <button className={`auth-tab ${view === 'login'    ? 'active' : ''}`} onClick={() => switchView('login')}>Log in</button>
                <button className={`auth-tab ${view === 'register' ? 'active' : ''}`} onClick={() => switchView('register')}>Create account</button>
              </div>
            </>
          )}
          {view === 'forgot' && <p className="auth-sub">Enter your email and we'll send a reset link.</p>}
          {view === 'reset'  && <p className="auth-sub">Choose a new password for your account.</p>}
        </div>

        {/* ── Login / Register form ── */}
        {(view === 'login' || view === 'register') && (
          <form className="auth-form" onSubmit={submitAuth}>
            {view === 'register' && (
              <label className="auth-field">
                <span>Name (optional)</span>
                <input type="text" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Your name" autoComplete="name" />
              </label>
            )}
            <label className="auth-field">
              <span>Email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" autoComplete="email" required />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input type="password" value={pass} onChange={e => setPass(e.target.value)}
                placeholder="••••••••" autoComplete={view === 'login' ? 'current-password' : 'new-password'} required />
            </label>
            {view === 'register' && (
              <label className="auth-field">
                <span>Confirm password</span>
                <input type="password" value={pass2} onChange={e => setPass2(e.target.value)}
                  placeholder="••••••••" autoComplete="new-password" required />
              </label>
            )}
            {view === 'login' && (
              <button type="button" className="auth-forgot-link" onClick={() => switchView('forgot')}>
                Forgot password?
              </button>
            )}
            {error && <p className="auth-error">{error}</p>}
            <div className="auth-footer">
              <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" type="submit" disabled={loading}>
                {loading ? '…' : view === 'login' ? 'Log in' : 'Create account'}
              </button>
            </div>
          </form>
        )}

        {/* ── Forgot password form ── */}
        {view === 'forgot' && (
          <form className="auth-form" onSubmit={submitForgot}>
            <label className="auth-field">
              <span>Email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" autoComplete="email" required />
            </label>
            {error && <p className="auth-error">{error}</p>}
            {info  && <p className="auth-info">{info}</p>}
            <div className="auth-footer">
              <button className="btn btn-ghost" type="button" onClick={() => switchView('login')}>← Back</button>
              <button className="btn btn-primary" type="submit" disabled={loading || Boolean(info)}>
                {loading ? '…' : 'Send reset link'}
              </button>
            </div>
          </form>
        )}

        {/* ── Reset password form ── */}
        {view === 'reset' && (
          <form className="auth-form" onSubmit={submitReset}>
            <label className="auth-field">
              <span>New password</span>
              <input type="password" value={pass} onChange={e => setPass(e.target.value)}
                placeholder="••••••••" autoComplete="new-password" required />
            </label>
            <label className="auth-field">
              <span>Confirm new password</span>
              <input type="password" value={pass2} onChange={e => setPass2(e.target.value)}
                placeholder="••••••••" autoComplete="new-password" required />
            </label>
            {error && <p className="auth-error">{error}</p>}
            <div className="auth-footer">
              <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" type="submit" disabled={loading}>
                {loading ? '…' : 'Set new password'}
              </button>
            </div>
          </form>
        )}

        {(view === 'login' || view === 'register') && (
          <p className="auth-device-note">
            No account needed — your layouts are already saved on this device.
          </p>
        )}
      </div>
    </div>
  )
}

/* ── UserBadge ────────────────────────────────────────────────────────────────
   Small header widget. When logged in: clicking the avatar opens a dropdown
   with the user name + Log out option (no stray buttons cluttering the bar).
*/
export function UserBadge({ user, onLoginClick, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef(null)

  /* Close on outside click / touch */
  useEffect(() => {
    if (!menuOpen) return
    const close = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('touchstart', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('touchstart', close)
    }
  }, [menuOpen])

  if (user) {
    const displayName = user.display_name || user.email || 'Account'
    const initials = displayName.slice(0, 2).toUpperCase()
    return (
      <div className="user-badge" ref={wrapRef}>
        <button
          className={`user-avatar-btn ${menuOpen ? 'user-avatar-btn--open' : ''}`}
          onClick={() => setMenuOpen(v => !v)}
          title={displayName}
          aria-expanded={menuOpen}
          aria-haspopup="true"
        >
          <span className="user-avatar">{initials}</span>
        </button>

        {menuOpen && (
          <div className="user-menu">
            <div className="user-menu-name" title={displayName}>
              <span className="user-menu-label">Signed in as</span>
              <span className="user-menu-email">{displayName}</span>
            </div>
            <div className="user-menu-divider" />
            <button
              className="user-menu-item user-menu-item--danger"
              onClick={() => { setMenuOpen(false); onLogout() }}
            >
              Log out
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="user-login-wrap">
      <span className="user-login-hint">save &amp; access across devices</span>
      <button className="btn btn-ghost btn-sm user-login-btn" onClick={onLoginClick}>
        ☁<span className="btn-label"> Log in</span>
      </button>
    </div>
  )
}
