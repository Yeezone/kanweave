/**
 * Application root: boots the auth state, routes between first-run bootstrap,
 * sign-in and the workspace, and owns the project selection plus the two
 * global overlays (card drawer and project settings).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { ProjectSummary, SessionView, UserView } from '../core/protocol.ts'
import {
  authBootstrap,
  authLogin,
  authLogout,
  authRegister,
  authState,
  consumeInviteRoute,
  dingtalkPoll,
  dingtalkStart,
  onUnauthorized,
  parseInviteToken,
  projectsList,
  uiMode,
} from './api.ts'
import type { EffectiveAuthState, EffectiveCapabilities, EffectiveProviders } from './api.ts'
import { I18nProvider, describeError, useI18n } from './locales.ts'
import { ToastProvider, useToast } from './toast.tsx'
import { Board } from './board.tsx'
import { CardDrawer } from './card-drawer.tsx'
import { InviteJoinDialog, ProjectSettings } from './members.tsx'
import { ProjectCreateDialog, ProjectRail } from './projects.tsx'
import { IconAlert, IconLogout, IconRefresh, IconUsers } from './icons.tsx'

export function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </I18nProvider>
  )
}

type AuthBusy = 'password' | 'bootstrap' | 'dingtalk' | null

function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?'
}

/** Locale switch (EN / 中文); the preference lives in the i18n provider. */
function LocaleToggle() {
  const { t, locale, setLocale } = useI18n()
  return (
    <button
      type="button"
      className="kw-locale-toggle"
      onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
      aria-label={t('common.switchLanguage')}
      title={t('common.switchLanguage')}
    >
      {locale === 'zh-CN' ? t('locale.en') : t('locale.zh')}
    </button>
  )
}

function AppShell() {
  const { t } = useI18n()
  const [auth, setAuth] = useState<EffectiveAuthState | null>(null)
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [inviteToken, setInviteToken] = useState<string | null>(() => parseInviteToken(window.location.pathname))
  const [focusProjectId, setFocusProjectId] = useState<string | null>(null)
  /** True while the operator explicitly asks to sign in as a project member. */
  const [accountSwitch, setAccountSwitch] = useState(false)

  const boot = useCallback(async () => {
    setBooting(true)
    setBootError(null)
    const result = await authState()
    setBooting(false)
    if (!result.ok) {
      setBootError(describeError(result, t))
      return
    }
    setAuth(result.value)
  }, [t])

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A session that expires while the UI is open drops back to the sign-in screen.
  useEffect(
    () =>
      onUnauthorized(() => {
        void authState().then((result) => {
          if (result.ok) setAuth(result.value)
        })
      }),
    [],
  )

  const handleSignedIn = useCallback((next: EffectiveAuthState) => {
    setBootError(null)
    setAuth(next)
  }, [])

  const clearInvite = useCallback(() => {
    consumeInviteRoute()
    setInviteToken(null)
  }, [])

  const handleInviteJoined = useCallback(
    (project: ProjectSummary | null) => {
      if (project) setFocusProjectId(project.id)
      clearInvite()
      // Accepting may have registered an account and set the session cookie.
      void authState().then((result) => {
        if (result.ok) setAuth(result.value)
      })
    },
    [clearInvite],
  )

  if (booting) {
    return (
      <div className="kw-splash">
        <div className="kw-splash-card">
          <span className="kw-brand">KanWeave</span>
          <p className="kw-muted">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  if (!auth) {
    return (
      <div className="kw-splash">
        <div className="kw-splash-card">
          <span className="kw-brand">KanWeave</span>
          <p className="kw-form-error" role="alert">
            {bootError ?? t('app.bootFailed')}
          </p>
          <button type="button" className="kw-button kw-button-primary" onClick={() => void boot()}>
            <IconRefresh size={14} />
            {t('common.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (!auth.session) {
    // A bare invite link collects registration (or sign-in) before joining.
    if (inviteToken) {
      return (
        <div className="kw-app kw-app-overlay-only">
          <InviteJoinDialog
            token={inviteToken}
            hasSession={false}
            onCancel={clearInvite}
            onSignedIn={handleSignedIn}
            onJoined={handleInviteJoined}
          />
        </div>
      )
    }
    return auth.providers.bootstrapOpen ? (
      <BootstrapScreen providers={auth.providers} onSignedIn={handleSignedIn} />
    ) : (
      <LoginScreen auth={auth} onSignedIn={handleSignedIn} />
    )
  }

  const session = auth.session

  // Host mode resolves the local operator implicitly; this lets that person sign
  // in as a project member in the same browser to check permissions.
  if (accountSwitch && auth.providers.password) {
    return (
      <LoginScreen
        auth={auth}
        onSignedIn={(next) => {
          setAccountSwitch(false)
          handleSignedIn(next)
        }}
        onCancel={() => setAccountSwitch(false)}
      />
    )
  }

  if (inviteToken) {
    return (
      <div className="kw-app kw-app-overlay-only">
        <InviteJoinDialog token={inviteToken} hasSession onCancel={clearInvite} onJoined={handleInviteJoined} />
      </div>
    )
  }

  return (
    <Workspace
      session={session}
      providers={auth.providers}
      capabilities={auth.capabilities}
      focusProjectId={focusProjectId}
      onFocusConsumed={() => setFocusProjectId(null)}
      onSwitchAccount={() => setAccountSwitch(true)}
      onSignOut={async () => {
        const result = await authLogout()
        if (result.ok) setAuth(result.value)
      }}
    />
  )
}

/* ------------------------------------------------------------------ *
 * Sign-in / bootstrap screens
 * ------------------------------------------------------------------ */

interface AuthLayoutProps {
  title: string
  subtitle: string
  notice?: string | null
  footer?: ReactNode
  children: ReactNode
}

function AuthLayout({ title, subtitle, notice, footer, children }: AuthLayoutProps) {
  return (
    <div className="kw-auth">
      <div className="kw-auth-topbar">
        <span className="kw-brand">KanWeave</span>
        <LocaleToggle />
      </div>
      <div className="kw-auth-card">
        <header className="kw-auth-header">
          <h1>{title}</h1>
          <p className="kw-muted">{subtitle}</p>
        </header>
        {notice ? (
          <p className="kw-auth-notice" role="status">
            {notice}
          </p>
        ) : null}
        {children}
        {footer ? <footer className="kw-auth-footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

interface LoginScreenProps {
  auth: EffectiveAuthState
  onSignedIn: (next: EffectiveAuthState) => void
  notice?: string | null
  onDismissInvite?: (() => void) | null
  /** Present when the user asked to switch accounts from inside a session. */
  onCancel?: (() => void) | null
}

function LoginScreen({ auth, onSignedIn, notice, onDismissInvite, onCancel }: LoginScreenProps) {
  const { t } = useI18n()
  const notify = useToast()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState<AuthBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const cancelledRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  const stopDingTalk = useCallback(() => {
    cancelledRef.current = true
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setWaiting(false)
    setBusy(null)
  }, [])

  useEffect(
    () => () => {
      cancelledRef.current = true
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const account = email.trim()
    if (mode === 'register' && !name.trim()) {
      setError(t('bootstrap.nameRequired'))
      return
    }
    if (!account) {
      setError(t('login.emailRequired'))
      return
    }
    if (!password) {
      setError(t('login.passwordRequired'))
      return
    }
    if (mode === 'register' && password.length < 8) {
      setError(t('login.passwordTooShort'))
      return
    }
    if (mode === 'register' && password !== confirm) {
      setError(t('bootstrap.passwordMismatch'))
      return
    }
    setBusy('password')
    setError(null)
    const result = mode === 'register' ? await authRegister(name.trim(), account, password) : await authLogin(account, password)
    setBusy(null)
    if (!result.ok) {
      if (result.code === 'conflict') {
        setError(t('register.emailTaken'))
        return
      }
      if (mode === 'register' && (result.code === 'forbidden' || result.code === 'FORBIDDEN')) {
        setError(t('register.closed'))
        return
      }
      if (mode === 'register') {
        setError(describeError(result, t))
        return
      }
      setError(
        result.code === 'bad-request' || result.code === 'unauthorized' || result.code === 'UNAUTHORIZED'
          ? t('login.invalidCredentials')
          : describeError(result, t),
      )
      return
    }
    onSignedIn(result.value)
  }

  async function startDingTalk() {
    if (busy) return
    setError(null)
    setBusy('dingtalk')
    const start = await dingtalkStart()
    if (!start.ok) {
      setBusy(null)
      setError(describeError(start, t))
      return
    }
    const info = start.value
    if (info.mode === 'unavailable' || !info.pendingId) {
      setBusy(null)
      notify({ kind: 'info', message: t('login.dingtalkUnavailable') })
      return
    }
    if (info.mode === 'oauth' && info.url) {
      window.open(info.url, '_blank', 'noopener')
    }
    cancelledRef.current = false
    setWaiting(true)

    const now = Date.now()
    const hardDeadline = now + 5 * 60 * 1000
    const expiresAt = info.expiresAt ? new Date(info.expiresAt).getTime() : Number.NaN
    const deadline = Number.isFinite(expiresAt) ? Math.min(hardDeadline, expiresAt) : hardDeadline

    const finish = (message: string | null) => {
      stopDingTalk()
      if (message) setError(message)
    }

    const tick = async () => {
      if (cancelledRef.current) return
      if (Date.now() > deadline) {
        finish(t('login.dingtalkExpired'))
        return
      }
      const result = await dingtalkPoll(info.pendingId ?? '')
      if (cancelledRef.current) return
      if (!result.ok) {
        finish(describeError(result, t))
        return
      }
      const status = result.value.status
      if (status === 'approved') {
        const state = await authState()
        if (cancelledRef.current) return
        if (state.ok && state.value.session) {
          stopDingTalk()
          onSignedIn(state.value)
        } else {
          finish(t('login.dingtalkFailed'))
        }
        return
      }
      if (status === 'denied') {
        finish(t('login.dingtalkDenied'))
        return
      }
      if (status === 'expired') {
        finish(t('login.dingtalkExpired'))
        return
      }
      if (status === 'unknown') {
        finish(t('login.dingtalkFailed'))
        return
      }
      timerRef.current = window.setTimeout(() => {
        void tick()
      }, 2000)
    }

    void tick()
  }

  const passwordEnabled = auth.providers.password
  const dingtalkEnabled = auth.capabilities.dingtalkLogin
  const registering = mode === 'register'
  const registrationEnabled = auth.providers.registration

  return (
    <AuthLayout
      title={registering ? t('register.title') : t('login.title')}
      subtitle={registering ? t('register.subtitle') : t('login.subtitle')}
      notice={notice}
      footer={
        auth.providers.bootstrapOpen ? (
          <p className="kw-muted kw-small">{t('login.bootstrapHint')}</p>
        ) : registering ? (
          <p className="kw-muted kw-small">{t('register.hint')}</p>
        ) : (
          <p className="kw-muted kw-small">{t('login.cookieHint')}</p>
        )
      }
    >
      {passwordEnabled ? (
        <form className="kw-form" onSubmit={(event) => void submit(event)}>
          {registering ? (
            <label className="kw-field">
              <span className="kw-field-label">{t('register.name')}</span>
              <input
                className="kw-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('register.namePlaceholder')}
                disabled={busy !== null}
                autoFocus
              />
            </label>
          ) : null}
          <label className="kw-field">
            <span className="kw-field-label">{t('login.email')}</span>
            <input
              className="kw-input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('login.emailPlaceholder')}
              disabled={busy !== null}
              autoFocus={!registering}
            />
          </label>
          <label className="kw-field">
            <span className="kw-field-label">{t('login.password')}</span>
            <input
              className="kw-input"
              type="password"
              autoComplete={registering ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={registering ? t('bootstrap.passwordPlaceholder') : t('login.passwordPlaceholder')}
              disabled={busy !== null}
            />
          </label>
          {registering ? (
            <label className="kw-field">
              <span className="kw-field-label">{t('bootstrap.confirm')}</span>
              <input
                className="kw-input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                disabled={busy !== null}
              />
            </label>
          ) : null}
          {error ? (
            <p className="kw-form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="kw-button kw-button-primary kw-button-block" disabled={busy !== null}>
            {registering
              ? busy === 'password'
                ? t('register.submitting')
                : t('register.submit')
              : busy === 'password'
                ? t('login.signingIn')
                : t('login.submit')}
          </button>
        </form>
      ) : null}

      {registrationEnabled && passwordEnabled && !auth.providers.bootstrapOpen ? (
        <button
          type="button"
          className="kw-link-button"
          disabled={busy !== null}
          onClick={() => {
            setError(null)
            setMode(registering ? 'login' : 'register')
          }}
        >
          {registering ? t('register.backToLogin') : t('register.link')}
        </button>
      ) : null}

      {dingtalkEnabled ? (
        <div className="kw-auth-divider">
          <span>{t('login.or')}</span>
        </div>
      ) : null}

      {dingtalkEnabled ? (
        waiting ? (
          <div className="kw-auth-waiting">
            <p className="kw-muted">{t('login.dingtalkWaiting')}</p>
            <button type="button" className="kw-button kw-button-small" onClick={stopDingTalk}>
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button type="button" className="kw-button kw-button-dingtalk kw-button-block" onClick={() => void startDingTalk()} disabled={busy !== null}>
            {t('login.dingtalk')}
          </button>
        )
      ) : null}

      {!passwordEnabled && !dingtalkEnabled ? <p className="kw-form-error">{t('login.noMethod')}</p> : null}

      {notice && onDismissInvite ? (
        <button type="button" className="kw-link-button" onClick={onDismissInvite}>
          {t('invite.skip')}
        </button>
      ) : null}

      {onCancel ? (
        <button type="button" className="kw-link-button" onClick={onCancel} disabled={busy !== null}>
          {t('auth.switchBack')}
        </button>
      ) : null}
    </AuthLayout>
  )
}

interface BootstrapScreenProps {
  providers: EffectiveProviders
  onSignedIn: (next: EffectiveAuthState) => void
}

function BootstrapScreen({ onSignedIn }: BootstrapScreenProps) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const account = email.trim()
    if (!account) {
      setError(t('login.emailRequired'))
      return
    }
    if (password.length < 8) {
      setError(t('login.passwordTooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('bootstrap.passwordMismatch'))
      return
    }
    setBusy(true)
    setError(null)
    const result = await authBootstrap(name.trim(), account, password)
    setBusy(false)
    if (!result.ok) {
      setError(result.code === 'conflict' ? t('bootstrap.exists') : describeError(result, t))
      return
    }
    onSignedIn(result.value)
  }

  return (
    <AuthLayout title={t('bootstrap.title')} subtitle={t('bootstrap.subtitle')} footer={<p className="kw-muted kw-small">{t('bootstrap.footer')}</p>}>
      <form className="kw-form" onSubmit={(event) => void submit(event)}>
        <label className="kw-field">
          <span className="kw-field-label">{t('bootstrap.name')}</span>
          <input
            className="kw-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('bootstrap.namePlaceholder')}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="kw-field">
          <span className="kw-field-label">{t('login.email')}</span>
          <input
            className="kw-input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t('login.emailPlaceholder')}
            disabled={busy}
          />
        </label>
        <label className="kw-field">
          <span className="kw-field-label">{t('bootstrap.password')}</span>
          <input
            className="kw-input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t('bootstrap.passwordPlaceholder')}
            disabled={busy}
          />
        </label>
        <label className="kw-field">
          <span className="kw-field-label">{t('bootstrap.confirm')}</span>
          <input
            className="kw-input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            disabled={busy}
          />
        </label>
        {error ? (
          <p className="kw-form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="kw-button kw-button-primary kw-button-block" disabled={busy}>
          {busy ? t('bootstrap.creating') : t('bootstrap.submit')}
        </button>
      </form>
    </AuthLayout>
  )
}

/* ------------------------------------------------------------------ *
 * Workspace
 * ------------------------------------------------------------------ */

interface WorkspaceProps {
  session: SessionView
  providers: EffectiveProviders
  capabilities: EffectiveCapabilities
  focusProjectId: string | null
  onFocusConsumed: () => void
  onSignOut: () => Promise<void>
  onSwitchAccount: () => void
}

function Workspace({ session, focusProjectId, onFocusConsumed, onSignOut, onSwitchAccount }: WorkspaceProps) {
  const { t } = useI18n()
  useToast()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [projectsVersion, setProjectsVersion] = useState(0)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeCardId, setActiveCardId] = useState<string | null>(null)
  const [boardRefresh, setBoardRefresh] = useState(0)
  const [signingOut, setSigningOut] = useState(false)

  const reloadProjects = useCallback(() => setProjectsVersion((value) => value + 1), [])

  useEffect(() => {
    let alive = true
    setProjectsLoading(true)
    void projectsList().then((result) => {
      if (!alive) return
      setProjectsLoading(false)
      if (!result.ok) {
        setProjectsError(describeError(result, t))
        return
      }
      setProjectsError(null)
      setProjects(result.value)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsVersion])

  // Keep the selection valid and pick something on first paint.
  useEffect(() => {
    if (projects.length === 0) {
      if (currentId !== null) setCurrentId(null)
      return
    }
    if (currentId !== null && projects.some((project) => project.id === currentId)) return
    const preferred = projects.find((project) => !project.archived) ?? projects[0]
    setCurrentId(preferred ? preferred.id : null)
  }, [projects, currentId])

  // Arriving from an accepted invite: jump straight into that project.
  useEffect(() => {
    if (!focusProjectId) return
    if (projects.some((project) => project.id === focusProjectId)) {
      setCurrentId(focusProjectId)
      onFocusConsumed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProjectId, projects])

  const currentProject = projects.find((project) => project.id === currentId) ?? null

  const handleProjectSeen = useCallback((project: ProjectSummary) => {
    setProjects((current) => current.map((entry) => (entry.id === project.id ? { ...entry, ...project } : entry)))
  }, [])

  const handleProjectUpdated = useCallback((project: ProjectSummary) => {
    setProjects((current) => current.map((entry) => (entry.id === project.id ? { ...entry, ...project } : entry)))
  }, [])

  const handleProjectDeleted = useCallback(() => {
    setSettingsOpen(false)
    setCurrentId(null)
    setActiveCardId(null)
    reloadProjects()
  }, [reloadProjects])

  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    await onSignOut()
    setSigningOut(false)
  }

  return (
    <div className="kw-app">
      <aside className="kw-sidebar">
        <ProjectRail
          projects={projects}
          currentId={currentId}
          showArchived={showArchived}
          loading={projectsLoading}
          canCreate
          onSelect={(projectId) => {
            setCurrentId(projectId)
            setActiveCardId(null)
            setSettingsOpen(false)
          }}
          onCreate={() => setCreateOpen(true)}
          onToggleArchived={() => setShowArchived((value) => !value)}
        />
        <div className="kw-rail-footer">
          <span className="kw-avatar" title={session.user.name} aria-hidden="true">
            {initialOf(session.user.name)}
          </span>
          <span className="kw-rail-user">
            <span className="kw-rail-user-name">{session.user.name}</span>
            <span className="kw-rail-user-email" title={session.user.email ?? undefined}>
              {session.user.email ?? ''}
            </span>
          </span>
          <LocaleToggle />
          {uiMode() === 'host' ? (
            <button
              type="button"
              className="kw-icon-button"
              aria-label={t('auth.switchAccount')}
              title={t('auth.switchAccount')}
              onClick={onSwitchAccount}
              disabled={signingOut}
            >
              <IconUsers size={16} />
            </button>
          ) : null}
          <button
            type="button"
            className="kw-icon-button"
            aria-label={t('auth.signOut')}
            title={t('auth.signOut')}
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            <IconLogout size={16} />
          </button>
        </div>
      </aside>

      <main className="kw-main">
        {projectsError ? (
          <div className="kw-banner kw-banner-error" role="alert">
            <IconAlert size={14} />
            <span>{projectsError}</span>
            <button type="button" className="kw-button kw-button-small" onClick={reloadProjects}>
              {t('common.retry')}
            </button>
          </div>
        ) : null}

        {currentProject ? (
          <Board
            key={currentProject.id}
            projectId={currentProject.id}
            role={currentProject.role}
            currentUser={session.user as UserView}
            activeCardId={activeCardId}
            onOpenCard={(cardId) => setActiveCardId(cardId)}
            onOpenSettings={() => setSettingsOpen(true)}
            onProjectSeen={handleProjectSeen}
            refreshToken={boardRefresh}
          />
        ) : projectsLoading ? (
          <p className="kw-muted kw-block-state">{t('common.loading')}</p>
        ) : (
          <div className="kw-empty kw-block-state">
            <p className="kw-empty-title">{t('workspace.emptyTitle')}</p>
            <p className="kw-muted">{t('workspace.emptyHint')}</p>
            <button type="button" className="kw-button kw-button-primary" onClick={() => setCreateOpen(true)}>
              {t('project.create')}
            </button>
          </div>
        )}
      </main>

      {createOpen ? (
        <ProjectCreateDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(project) => {
            setCreateOpen(false)
            setCurrentId(project.id)
            reloadProjects()
          }}
        />
      ) : null}

      {settingsOpen && currentProject ? (
        <ProjectSettings
          project={currentProject}
          role={currentProject.role}
          onClose={() => setSettingsOpen(false)}
          onProjectUpdated={handleProjectUpdated}
          onProjectDeleted={handleProjectDeleted}
        />
      ) : null}

      {activeCardId && currentProject ? (
        <CardDrawer
          cardId={activeCardId}
          role={currentProject.role}
          currentUser={session.user as UserView}
          onClose={() => setActiveCardId(null)}
          onChanged={() => setBoardRefresh((value) => value + 1)}
          onDeleted={() => {
            setActiveCardId(null)
            setBoardRefresh((value) => value + 1)
          }}
        />
      ) : null}
    </div>
  )
}
