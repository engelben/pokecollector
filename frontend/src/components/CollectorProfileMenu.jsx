import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, LockKeyhole, Settings2, UserRound } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import CollectorProfileManager from './CollectorProfileManager'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'

function Avatar({ profile, className = 'h-6 w-6' }) {
  if (!profile?.avatar_id) {
    return <span className={`${className} rounded-full bg-bg-elevated inline-flex items-center justify-center`}><UserRound size={14} /></span>
  }
  return <img src={`${SPRITE_BASE_URL}/${profile.avatar_id}.gif`} alt="" className={`${className} object-contain pixelated`} />
}

export default function CollectorProfileMenu({ compact = false }) {
  const { t } = useSettings()
  const {
    user,
    profiles,
    actorUserId,
    profilesLoading,
    refreshProfiles,
    switchProfile,
    switchBack,
  } = useAuth()
  const [open, setOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [pinPrompt, setPinPrompt] = useState(false)
  const [pin, setPin] = useState('')
  const rootRef = useRef(null)
  const isPrimaryActive = user?.id === actorUserId && !user?.managed_profile

  useEffect(() => {
    if (!open) return
    refreshProfiles().catch(() => {})
    const close = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, refreshProfiles])

  const runSwitch = async (profile) => {
    if (profile.id === user?.id || switching) return
    setSwitching(true)
    try {
      if (profile.id === actorUserId && user?.managed_profile) {
        if (user.profile_pin_required) {
          setPinPrompt(true)
          setSwitching(false)
          return
        }
        await switchBack()
      } else {
        await switchProfile(profile.id)
      }
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('collectorProfiles.switchFailed'))
      setSwitching(false)
    }
  }

  const submitPin = async (event) => {
    event.preventDefault()
    setSwitching(true)
    try {
      await switchBack(pin)
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('collectorProfiles.switchFailed'))
      setSwitching(false)
    }
  }

  return (
    <>
      <div className="relative" ref={rootRef}>
        <button
          type="button"
          onClick={() => setOpen(value => !value)}
          className={`flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 text-text-secondary hover:text-text-primary transition-colors ${compact ? 'px-2 py-1.5' : 'px-2.5 py-1.5'}`}
          aria-label={t('collectorProfiles.switchCollector')}
        >
          <Avatar profile={user} />
          {!compact && <span className="max-w-24 truncate text-xs font-semibold">{user?.username}</span>}
          <ChevronDown size={13} />
        </button>

        {open && (
          <div className="absolute right-0 top-full z-[80] mt-2 w-72 overflow-hidden rounded-2xl border border-border bg-bg-surface shadow-2xl">
            <div className="border-b border-border px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-text-muted">{t('collectorProfiles.collectingAs')}</p>
              <div className="mt-1 flex items-center gap-2">
                <Avatar profile={user} className="h-8 w-8" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-text-primary">{user?.username}</p>
                  {user?.managed_profile && <p className="text-[11px] text-yellow">{t('collectorProfiles.managedProfile')}</p>}
                </div>
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto p-2">
              {profilesLoading && profiles.length === 0 ? (
                <p className="p-3 text-center text-xs text-text-muted">{t('common.loading')}</p>
              ) : profiles.map(profile => (
                <button
                  key={profile.id}
                  type="button"
                  disabled={!profile.is_active || switching}
                  onClick={() => runSwitch(profile)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-bg-elevated disabled:opacity-40"
                >
                  <Avatar profile={profile} className="h-8 w-8" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{profile.username}</p>
                    <p className="text-[11px] text-text-muted">
                      {profile.managed ? t('collectorProfiles.managedProfile') : t('collectorProfiles.primaryProfile')}
                    </p>
                  </div>
                  {profile.id === user?.id && <Check size={16} className="text-green" />}
                  {profile.profile_pin_required && <LockKeyhole size={14} className="text-yellow" />}
                </button>
              ))}
            </div>

            {pinPrompt && (
              <form onSubmit={submitPin} className="border-t border-border p-3 space-y-2">
                <p className="text-xs text-text-secondary">{t('collectorProfiles.enterPin')}</p>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                    className="input flex-1 py-1.5"
                    placeholder="••••"
                  />
                  <button className="btn-primary px-3" disabled={switching || pin.length < 4}>{t('collectorProfiles.switch')}</button>
                </div>
              </form>
            )}

            {isPrimaryActive && (
              <button
                type="button"
                onClick={() => { setOpen(false); setManageOpen(true) }}
                className="flex w-full items-center justify-center gap-2 border-t border-border px-4 py-3 text-sm text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
              >
                <Settings2 size={16} /> {t('collectorProfiles.manage')}
              </button>
            )}
          </div>
        )}
      </div>

      <CollectorProfileManager isOpen={manageOpen} onClose={() => setManageOpen(false)} />
    </>
  )
}
