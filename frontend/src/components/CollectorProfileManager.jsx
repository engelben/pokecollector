import { useMemo, useState } from 'react'
import { KeyRound, Pencil, Plus, Power, Trash2, UserRound } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import AvatarPicker from './AvatarPicker'
import Modal from './ui/Modal'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'

function ProfileAvatar({ profile, size = 'h-10 w-10' }) {
  if (!profile?.avatar_id) {
    return <div className={`${size} rounded-full bg-bg-elevated flex items-center justify-center`}><UserRound size={18} /></div>
  }
  return (
    <img
      src={`${SPRITE_BASE_URL}/${profile.avatar_id}.gif`}
      alt=""
      className={`${size} object-contain pixelated`}
    />
  )
}

export default function CollectorProfileManager({ isOpen, onClose }) {
  const { t } = useSettings()
  const {
    profiles,
    createProfile,
    updateProfile,
    updateProfilePin,
    removeProfile,
  } = useAuth()
  const managedProfiles = useMemo(() => profiles.filter(profile => profile.managed), [profiles])
  const [newName, setNewName] = useState('')
  const [newAvatarId, setNewAvatarId] = useState(null)
  const [avatarTarget, setAvatarTarget] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [pinProfileId, setPinProfileId] = useState(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (work, successMessage) => {
    setBusy(true)
    try {
      await work()
      if (successMessage) toast.success(successMessage)
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('common.failed'))
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = (event) => {
    event.preventDefault()
    if (!newName.trim()) return
    run(async () => {
      await createProfile({ username: newName.trim(), avatar_id: newAvatarId })
      setNewName('')
      setNewAvatarId(null)
    }, t('collectorProfiles.created'))
  }

  const saveName = (profile) => {
    if (!editingName.trim()) return
    run(async () => {
      await updateProfile(profile.id, { username: editingName.trim() })
      setEditingId(null)
      setEditingName('')
    }, t('collectorProfiles.saved'))
  }

  const savePin = (profile) => {
    run(async () => {
      await updateProfilePin(profile.id, pin || null)
      setPin('')
      setPinProfileId(null)
    }, pin ? t('collectorProfiles.pinSaved') : t('collectorProfiles.pinRemoved'))
  }

  const deleteProfile = (profile) => {
    const confirmation = window.prompt(t('collectorProfiles.deleteConfirm').replace('{name}', profile.username))
    if (confirmation !== profile.username) return
    run(() => removeProfile(profile.id, confirmation), t('collectorProfiles.deleted'))
  }

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title={t('collectorProfiles.manage')} size="lg">
        <div className="p-4 space-y-5">
          <form onSubmit={handleCreate} className="rounded-2xl border border-border bg-bg-elevated/30 p-4 space-y-3">
            <div>
              <h3 className="font-semibold text-text-primary">{t('collectorProfiles.add')}</h3>
              <p className="text-xs text-text-muted mt-1">{t('collectorProfiles.addHelp')}</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setAvatarTarget({ id: 'new', avatar_id: newAvatarId })}
                className="h-14 w-14 rounded-xl border border-border bg-bg-card flex items-center justify-center"
                title={t('auth.chooseAvatar')}
              >
                <ProfileAvatar profile={{ avatar_id: newAvatarId }} size="h-11 w-11" />
              </button>
              <input
                value={newName}
                onChange={event => setNewName(event.target.value)}
                className="input flex-1"
                maxLength={32}
                placeholder={t('collectorProfiles.namePlaceholder')}
              />
              <button disabled={busy || !newName.trim()} className="btn-primary px-3">
                <Plus size={16} /> {t('common.add')}
              </button>
            </div>
          </form>

          <div className="space-y-3">
            {managedProfiles.length === 0 && (
              <div className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-text-muted">
                {t('collectorProfiles.none')}
              </div>
            )}
            {managedProfiles.map(profile => (
              <div key={profile.id} className="rounded-2xl border border-border bg-bg-card p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setAvatarTarget(profile)}
                    className="h-12 w-12 rounded-xl border border-border bg-bg-elevated flex items-center justify-center"
                    title={t('auth.chooseAvatar')}
                  >
                    <ProfileAvatar profile={profile} />
                  </button>
                  <div className="min-w-0 flex-1">
                    {editingId === profile.id ? (
                      <div className="flex gap-2">
                        <input
                          autoFocus
                          value={editingName}
                          onChange={event => setEditingName(event.target.value)}
                          className="input flex-1 py-1.5"
                          maxLength={32}
                        />
                        <button type="button" className="btn-primary px-3" disabled={busy} onClick={() => saveName(profile)}>
                          {t('common.save')}
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="font-semibold text-text-primary truncate">{profile.username}</p>
                        <p className="text-xs text-text-muted">
                          {profile.is_active ? t('collectorProfiles.active') : t('collectorProfiles.disabled')}
                          {profile.profile_pin_required ? ` · ${t('collectorProfiles.pinProtected')}` : ''}
                        </p>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setEditingId(profile.id); setEditingName(profile.username) }}
                    className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-elevated"
                    title={t('common.edit')}
                  >
                    <Pencil size={16} />
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(
                      () => updateProfile(profile.id, { is_active: !profile.is_active }),
                      profile.is_active ? t('collectorProfiles.disabledMessage') : t('collectorProfiles.enabledMessage')
                    )}
                    className="btn-ghost justify-center text-xs"
                  >
                    <Power size={14} /> {profile.is_active ? t('collectorProfiles.disable') : t('collectorProfiles.enable')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPinProfileId(profile.id); setPin('') }}
                    className="btn-ghost justify-center text-xs"
                  >
                    <KeyRound size={14} /> {t('collectorProfiles.pin')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => deleteProfile(profile)}
                    className="btn-ghost justify-center text-xs text-brand-red sm:col-auto col-span-2"
                  >
                    <Trash2 size={14} /> {t('common.delete')}
                  </button>
                </div>

                {pinProfileId === profile.id && (
                  <div className="rounded-xl border border-border bg-bg-elevated/40 p-3 space-y-2">
                    <p className="text-xs text-text-secondary">{t('collectorProfiles.pinHelp')}</p>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={pin}
                        onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                        placeholder={profile.profile_pin_required ? t('collectorProfiles.pinReplacePlaceholder') : t('collectorProfiles.pinPlaceholder')}
                        className="input flex-1"
                      />
                      <button type="button" disabled={busy || (pin && pin.length < 4)} onClick={() => savePin(profile)} className="btn-primary px-3">
                        {pin ? t('common.save') : t('collectorProfiles.removePin')}
                      </button>
                      <button type="button" onClick={() => { setPinProfileId(null); setPin('') }} className="btn-ghost px-3">
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted">{t('collectorProfiles.futureIdentity')}</p>
        </div>
      </Modal>

      <AvatarPicker
        isOpen={Boolean(avatarTarget)}
        onClose={() => setAvatarTarget(null)}
        currentAvatarId={avatarTarget?.avatar_id || null}
        onSelect={(avatarId) => {
          if (avatarTarget?.id === 'new') {
            setNewAvatarId(avatarId)
            setAvatarTarget(null)
            return
          }
          const targetId = avatarTarget?.id
          setAvatarTarget(null)
          if (targetId) run(() => updateProfile(targetId, { avatar_id: avatarId }), t('collectorProfiles.saved'))
        }}
      />
    </>
  )
}
