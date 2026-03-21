import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useSettingsStore } from '../store/settingsStore'
import { useTranslation } from '../i18n'
import { authApi } from '../api/client'
import { Plane, Eye, EyeOff, Mail, Lock, MapPin, Calendar, Package, User, Globe, Zap, Users, Wallet, Map, CheckSquare, BookMarked, FolderOpen, Route, Shield } from 'lucide-react'

export default function LoginPage() {
  const { t, language } = useTranslation()
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [appConfig, setAppConfig] = useState(null)

  const { login, register, demoLogin } = useAuthStore()
  const { setLanguageLocal } = useSettingsStore()
  const navigate = useNavigate()

  useEffect(() => {
    authApi.getAppConfig?.().catch(() => null).then(config => {
      if (config) {
        setAppConfig(config)
        if (!config.has_users) setMode('register')
      }
    })

    // Handle OIDC callback token (via URL fragment to avoid logging)
    const hash = window.location.hash.substring(1)
    const hashParams = new URLSearchParams(hash)
    const token = hashParams.get('token')
    const params = new URLSearchParams(window.location.search)
    const oidcError = params.get('oidc_error')
    if (token) {
      localStorage.setItem('auth_token', token)
      window.history.replaceState({}, '', '/login')
      login.__fromOidc = true
      navigate('/dashboard')
      window.location.reload()
    }
    if (oidcError) {
      const errorMessages = {
        registration_disabled: language === 'de' ? 'Registrierung ist deaktiviert. Kontaktiere den Administrator.' : 'Registration is disabled. Contact your administrator.',
        no_email: language === 'de' ? 'Keine E-Mail vom Provider erhalten.' : 'No email received from provider.',
        token_failed: language === 'de' ? 'Authentifizierung fehlgeschlagen.' : 'Authentication failed.',
        invalid_state: language === 'de' ? 'Ungueltige Sitzung. Bitte erneut versuchen.' : 'Invalid session. Please try again.',
      }
      setError(errorMessages[oidcError] || oidcError)
      window.history.replaceState({}, '', '/login')
    }
  }, [])

  const handleDemoLogin = async () => {
    setError('')
    setIsLoading(true)
    try {
      await demoLogin()
      navigate('/dashboard')
    } catch (err) {
      setError(err.message || 'Demo-Login fehlgeschlagen')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)
    try {
      if (mode === 'register') {
        if (!username.trim()) { setError('Username is required'); setIsLoading(false); return }
        if (password.length < 6) { setError('Password must be at least 6 characters'); setIsLoading(false); return }
        await register(username, email, password)
      } else {
        await login(email, password)
      }
      navigate('/dashboard')
    } catch (err) {
      setError(err.message || t('login.error'))
    } finally {
      setIsLoading(false)
    }
  }

  const showRegisterOption = appConfig?.allow_registration || !appConfig?.has_users

  const inputBase = {
    width: '100%', padding: '11px 12px 11px 40px', border: '1px solid #e5e7eb',
    borderRadius: 12, fontSize: 14, fontFamily: 'inherit', outline: 'none',
    color: '#111827', background: 'white', boxSizing: 'border-box', transition: 'border-color 0.15s',
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif", position: 'relative' }}>

      {/* Sprach-Toggle oben rechts */}
      <button
        onClick={() => setLanguageLocal(language === 'en' ? 'de' : 'en')}
        style={{
          position: 'absolute', top: 16, right: 16, zIndex: 10,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 99,
          background: 'rgba(0,0,0,0.06)', border: 'none',
          fontSize: 13, fontWeight: 500, color: '#374151',
          cursor: 'pointer', fontFamily: 'inherit',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.1)'}
        onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.06)'}
      >
        <Globe size={14} />
        {language === 'en' ? 'DE' : 'EN'}
      </button>

      {/* Left — branding */}
      <div style={{ display: 'none', width: '55%', background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '60px 48px', position: 'relative', overflow: 'hidden' }}
        className="lg-panel">
        <style>{`@media(min-width:1024px){.lg-panel{display:flex!important}}`}</style>

        {/* Stars */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
          {Array.from({ length: 40 }, (_, i) => (
            <div key={i} className="login-star" style={{
              position: 'absolute',
              width: Math.random() > 0.7 ? 2 : 1,
              height: Math.random() > 0.7 ? 2 : 1,
              borderRadius: '50%',
              background: 'white',
              opacity: 0.15 + Math.random() * 0.25,
              top: `${Math.random() * 70}%`,
              left: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 4}s`,
            }} />
          ))}
        </div>

        {/* Animated glow orbs */}
        <div className="login-orb1" style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)', filter: 'blur(80px)' }} />
        <div className="login-orb2" style={{ position: 'absolute', width: 350, height: 350, borderRadius: '50%', background: 'radial-gradient(circle, rgba(14,165,233,0.08) 0%, transparent 70%)', filter: 'blur(60px)' }} />

        {/* Animated planes — realistic silhouettes at different sizes/speeds */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          {/* Plane 1 — large, slow, foreground */}
          <svg className="login-plane1" viewBox="0 0 480 120" style={{ position: 'absolute', width: 48, opacity: 0.12 }}>
            <g fill="white" transform="translate(240,60) rotate(-12)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <path d="M-100,-5 L-120,-30 L-108,-30 L-90,-8 Z" />
              <path d="M-100,5 L-120,30 L-108,30 L-90,8 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 2 — small, faster, higher */}
          <svg className="login-plane2" viewBox="0 0 480 120" style={{ position: 'absolute', width: 24, opacity: 0.08 }}>
            <g fill="white" transform="translate(240,60) rotate(-12)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 3 — medium, mid-speed */}
          <svg className="login-plane3" viewBox="0 0 480 120" style={{ position: 'absolute', width: 32, opacity: 0.06 }}>
            <g fill="white" transform="translate(240,60) rotate(-5)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <path d="M-100,-5 L-120,-30 L-108,-30 L-90,-8 Z" />
              <path d="M-100,5 L-120,30 L-108,30 L-90,8 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 4 — tiny, fast, high */}
          <svg className="login-plane4" viewBox="0 0 480 120" style={{ position: 'absolute', width: 16, opacity: 0.07 }}>
            <g fill="white" transform="translate(240,60) rotate(-10)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 5 — medium, right to left, lower */}
          <svg className="login-plane5" viewBox="0 0 480 120" style={{ position: 'absolute', width: 28, opacity: 0.05 }}>
            <g fill="white" transform="translate(240,60) rotate(8) scale(-1,1)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <path d="M-100,-5 L-120,-30 L-108,-30 L-90,-8 Z" />
              <path d="M-100,5 L-120,30 L-108,30 L-90,8 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>

          {/* Plane 6 — tiny distant */}
          <svg className="login-plane6" viewBox="0 0 480 120" style={{ position: 'absolute', width: 12, opacity: 0.04 }}>
            <g fill="white" transform="translate(240,60) rotate(-15)">
              <ellipse cx="0" cy="0" rx="120" ry="12" />
              <path d="M-20,-10 L-60,-55 L-40,-55 L0,-15 Z" />
              <path d="M-20,10 L-60,55 L-40,55 L0,15 Z" />
              <ellipse cx="60" cy="0" rx="18" ry="8" />
            </g>
          </svg>
        </div>


        <div style={{ position: 'relative', zIndex: 1, maxWidth: 560, textAlign: 'center' }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 48, justifyContent: 'center' }}>
            <div style={{ width: 48, height: 48, background: 'white', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 30px rgba(255,255,255,0.1)' }}>
              <Plane size={24} style={{ color: '#0f172a' }} />
            </div>
            <span style={{ fontSize: 28, fontWeight: 800, color: 'white', letterSpacing: '-0.02em' }}>NOMAD</span>
          </div>

          <h2 style={{ margin: '0 0 12px', fontSize: 36, fontWeight: 800, color: 'white', lineHeight: 1.15, letterSpacing: '-0.02em' }}>
            {t('login.tagline')}
          </h2>
          <p style={{ margin: '0 0 44px', fontSize: 15, color: 'rgba(255,255,255,0.5)', lineHeight: 1.7 }}>
            {t('login.description')}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {[
              { Icon: Map, label: t('login.features.maps'), desc: t('login.features.mapsDesc') },
              { Icon: Zap, label: t('login.features.realtime'), desc: t('login.features.realtimeDesc') },
              { Icon: Wallet, label: t('login.features.budget'), desc: t('login.features.budgetDesc') },
              { Icon: Users, label: t('login.features.collab'), desc: t('login.features.collabDesc') },
              { Icon: CheckSquare, label: t('login.features.packing'), desc: t('login.features.packingDesc') },
              { Icon: BookMarked, label: t('login.features.bookings'), desc: t('login.features.bookingsDesc') },
              { Icon: FolderOpen, label: t('login.features.files'), desc: t('login.features.filesDesc') },
              { Icon: Route, label: t('login.features.routes'), desc: t('login.features.routesDesc') },
            ].map(({ Icon, label, desc }) => (
              <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 14, padding: '14px 12px', border: '1px solid rgba(255,255,255,0.06)', textAlign: 'left', transition: 'all 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)' }}>
                <Icon size={17} style={{ color: 'rgba(255,255,255,0.7)', marginBottom: 7 }} />
                <div style={{ fontSize: 12.5, color: 'white', fontWeight: 600, marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.4 }}>{desc}</div>
              </div>
            ))}
          </div>

          <p style={{ marginTop: 36, fontSize: 11.5, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.03em' }}>
            {t('login.selfHosted')}
          </p>
        </div>
      </div>

      {/* Right — form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 24px', background: '#f9fafb' }}>
        <div style={{ width: '100%', maxWidth: 400 }}>

          {/* Mobile logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 36, justifyContent: 'center' }}
            className="mobile-logo">
            <style>{`@media(min-width:1024px){.mobile-logo{display:none!important}}`}</style>
            <div style={{ width: 36, height: 36, background: '#111827', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Plane size={18} style={{ color: 'white' }} />
            </div>
            <span style={{ fontSize: 22, fontWeight: 800, color: '#111827', letterSpacing: '-0.02em' }}>NOMAD</span>
          </div>

          <div style={{ background: 'white', borderRadius: 20, border: '1px solid #e5e7eb', padding: '36px 32px', boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#111827' }}>
              {mode === 'register' ? (!appConfig?.has_users ? t('login.createAdmin') : t('login.createAccount')) : t('login.title')}
            </h2>
            <p style={{ margin: '0 0 28px', fontSize: 13.5, color: '#9ca3af' }}>
              {mode === 'register' ? (!appConfig?.has_users ? t('login.createAdminHint') : t('login.createAccountHint')) : t('login.subtitle')}
            </p>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {error && (
                <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, fontSize: 13, color: '#dc2626' }}>
                  {error}
                </div>
              )}

              {/* Username (register only) */}
              {mode === 'register' && (
                <div>
                  <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('login.username')}</label>
                  <div style={{ position: 'relative' }}>
                    <User size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                    <input
                      type="text" value={username} onChange={e => setUsername(e.target.value)} required
                      placeholder="admin" style={inputBase}
                      onFocus={e => e.target.style.borderColor = '#111827'}
                      onBlur={e => e.target.style.borderColor = '#e5e7eb'}
                    />
                  </div>
                </div>
              )}

              {/* Email */}
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('common.email')}</label>
                <div style={{ position: 'relative' }}>
                  <Mail size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)} required
                    placeholder={t('login.emailPlaceholder')} style={inputBase}
                    onFocus={e => e.target.style.borderColor = '#111827'}
                    onBlur={e => e.target.style.borderColor = '#e5e7eb'}
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('common.password')}</label>
                <div style={{ position: 'relative' }}>
                  <Lock size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
                  <input
                    type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required
                    placeholder="••••••••" style={{ ...inputBase, paddingRight: 44 }}
                    onFocus={e => e.target.style.borderColor = '#111827'}
                    onBlur={e => e.target.style.borderColor = '#e5e7eb'}
                  />
                  <button type="button" onClick={() => setShowPassword(v => !v)} style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: '#9ca3af',
                  }}>
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <button type="submit" disabled={isLoading} style={{
                marginTop: 4, width: '100%', padding: '12px', background: '#111827', color: 'white',
                border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: isLoading ? 'default' : 'pointer',
                fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                opacity: isLoading ? 0.7 : 1, transition: 'opacity 0.15s',
              }}
                onMouseEnter={e => { if (!isLoading) e.currentTarget.style.background = '#1f2937' }}
                onMouseLeave={e => e.currentTarget.style.background = '#111827'}
              >
                {isLoading
                  ? <><div style={{ width: 15, height: 15, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />{mode === 'register' ? t('login.creating') : t('login.signingIn')}</>
                  : mode === 'register' ? t('login.createAccount') : t('login.signIn')
                }
              </button>
            </form>

            {/* Toggle login/register */}
            {showRegisterOption && appConfig?.has_users && !appConfig?.demo_mode && (
              <p style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: '#9ca3af' }}>
                {mode === 'login' ? t('login.noAccount') + ' ' : t('login.hasAccount') + ' '}
                <button onClick={() => { setMode(m => m === 'login' ? 'register' : 'login'); setError('') }}
                  style={{ background: 'none', border: 'none', color: '#111827', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
                  {mode === 'login' ? t('login.register') : t('login.signIn')}
                </button>
              </p>
            )}
          </div>

          {/* OIDC / SSO login button */}
          {appConfig?.oidc_configured && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
                <span style={{ fontSize: 12, color: '#9ca3af' }}>{language === 'de' ? 'oder' : 'or'}</span>
                <div style={{ flex: 1, height: 1, background: '#e5e7eb' }} />
              </div>
              <a href="/api/auth/oidc/login"
                style={{
                  marginTop: 12, width: '100%', padding: '12px',
                  background: 'white', color: '#374151',
                  border: '1px solid #d1d5db', borderRadius: 12,
                  fontSize: 14, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  textDecoration: 'none', transition: 'all 0.15s',
                  boxSizing: 'border-box',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.borderColor = '#9ca3af' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'white'; e.currentTarget.style.borderColor = '#d1d5db' }}
              >
                <Shield size={16} />
                {language === 'de' ? `Anmelden mit ${appConfig.oidc_display_name}` : `Sign in with ${appConfig.oidc_display_name}`}
              </a>
            </>
          )}

          {/* Demo login button */}
          {appConfig?.demo_mode && (
            <button onClick={handleDemoLogin} disabled={isLoading}
              style={{
                marginTop: 16, width: '100%', padding: '14px',
                background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                color: '#451a03', border: 'none', borderRadius: 14,
                fontSize: 15, fontWeight: 700, cursor: isLoading ? 'default' : 'pointer',
                fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                opacity: isLoading ? 0.7 : 1, transition: 'all 0.2s',
                boxShadow: '0 2px 12px rgba(245, 158, 11, 0.3)',
              }}
              onMouseEnter={e => { if (!isLoading) e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(245, 158, 11, 0.4)' }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 2px 12px rgba(245, 158, 11, 0.3)' }}
            >
              <Plane size={18} />
              {language === 'de' ? 'Demo ausprobieren — ohne Registrierung' : 'Try the demo — no registration needed'}
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes orbFloat1 {
          0%, 100% { top: 15%; left: 30%; }
          25% { top: 25%; left: 55%; }
          50% { top: 45%; left: 40%; }
          75% { top: 20%; left: 20%; }
        }
        @keyframes orbFloat2 {
          0%, 100% { bottom: 20%; right: 15%; }
          25% { bottom: 35%; right: 35%; }
          50% { bottom: 15%; right: 45%; }
          75% { bottom: 40%; right: 20%; }
        }
        .login-orb1 { animation: orbFloat1 20s ease-in-out infinite; }
        .login-orb2 { animation: orbFloat2 25s ease-in-out infinite; }

        @keyframes twinkle {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.5; }
        }
        .login-star { animation: twinkle 3s ease-in-out infinite; }

        @keyframes plane1Move {
          0%   { left: -8%; top: 30%; transform: rotate(-8deg); }
          100% { left: 108%; top: 10%; transform: rotate(-12deg); }
        }
        @keyframes plane2Move {
          0%   { right: -5%; top: 18%; transform: rotate(5deg); }
          100% { right: 110%; top: 8%; transform: rotate(3deg); }
        }
        @keyframes plane3Move {
          0%   { left: -6%; top: 55%; transform: rotate(-10deg); }
          100% { left: 110%; top: 35%; transform: rotate(-6deg); }
        }
        @keyframes plane4Move {
          0%   { left: -4%; top: 8%; transform: rotate(-3deg); }
          100% { left: 110%; top: 5%; transform: rotate(-5deg); }
        }
        @keyframes plane5Move {
          0%   { right: -6%; top: 65%; transform: rotate(3deg); }
          100% { right: 110%; top: 50%; transform: rotate(-2deg); }
        }
        @keyframes plane6Move {
          0%   { left: -3%; top: 75%; transform: rotate(-7deg); }
          100% { left: 110%; top: 58%; transform: rotate(-5deg); }
        }
        .login-plane1 { animation: plane1Move 24s ease-in-out infinite; }
        .login-plane2 { animation: plane2Move 18s ease-in-out infinite; animation-delay: 6s; }
        .login-plane3 { animation: plane3Move 30s ease-in-out infinite; animation-delay: 12s; }
        .login-plane4 { animation: plane4Move 14s ease-in-out infinite; animation-delay: 3s; }
        .login-plane5 { animation: plane5Move 22s ease-in-out infinite; animation-delay: 9s; }
        .login-plane6 { animation: plane6Move 32s ease-in-out infinite; animation-delay: 16s; }

      `}</style>
    </div>
  )
}
