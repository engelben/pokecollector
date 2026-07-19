import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  createCollectorProfile,
  deleteCollectorProfile,
  getAuthMode,
  getCollectorProfiles,
  getMe,
  setCollectorProfilePin,
  switchBackCollectorProfile,
  switchCollectorProfile,
  updateCollectorProfile,
} from '../api/client'

const AuthContext = createContext(null)

function readStoredUser() {
  const stored = localStorage.getItem('user')
  if (!stored) return null
  try {
    return JSON.parse(stored)
  } catch {
    localStorage.removeItem('user')
    return null
  }
}

function storeUser(user) {
  if (user) localStorage.setItem('user', JSON.stringify(user))
  else localStorage.removeItem('user')
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(readStoredUser)
  const [loading, setLoading] = useState(true)
  const [multiUser, setMultiUser] = useState(true)
  const [profiles, setProfiles] = useState([])
  const [actorUserId, setActorUserId] = useState(null)
  const [profilesLoading, setProfilesLoading] = useState(false)

  const refreshProfiles = useCallback(async () => {
    setProfilesLoading(true)
    try {
      const data = await getCollectorProfiles()
      setProfiles(data.profiles || [])
      setActorUserId(data.actor_user_id ?? null)
      return data
    } finally {
      setProfilesLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      try {
        const { multi_user } = await getAuthMode()
        if (cancelled) return
        setMultiUser(multi_user)

        const token = localStorage.getItem('token')
        if (multi_user && !token) {
          setUser(null)
          setProfiles([])
          setActorUserId(null)
          return
        }

        const currentUser = await getMe()
        if (cancelled) return
        setUser(currentUser)
        storeUser(currentUser)

        try {
          const profileData = await getCollectorProfiles()
          if (!cancelled) {
            setProfiles(profileData.profiles || [])
            setActorUserId(profileData.actor_user_id ?? null)
          }
        } catch {
          if (!cancelled) {
            setProfiles([])
            setActorUserId(currentUser.actor_user_id ?? currentUser.id ?? null)
          }
        }
      } catch {
        if (!cancelled) {
          localStorage.removeItem('token')
          storeUser(null)
          setUser(null)
          setProfiles([])
          setActorUserId(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    restore()
    return () => { cancelled = true }
  }, [])

  const loginUser = (token, userData) => {
    localStorage.setItem('token', token)
    storeUser(userData)
    setUser(userData)
  }

  const updateCurrentUser = (updates) => {
    setUser((prev) => {
      const next = prev ? { ...prev, ...updates } : prev
      storeUser(next)
      return next
    })
  }

  const applyProfileSession = (session) => {
    localStorage.setItem('token', session.access_token)
    storeUser(session.user)
    setUser(session.user)
    // A full reload is intentional: it clears every React Query cache and any
    // open editor/import state that belongs to the previous collector.
    window.location.href = '/'
  }

  const switchProfile = async (profileId) => {
    const session = await switchCollectorProfile(profileId)
    applyProfileSession(session)
  }

  const switchBack = async (pin = null) => {
    const session = await switchBackCollectorProfile(pin)
    applyProfileSession(session)
  }

  const createProfile = async (data) => {
    const result = await createCollectorProfile(data)
    await refreshProfiles()
    return result
  }

  const updateProfile = async (profileId, data) => {
    const result = await updateCollectorProfile(profileId, data)
    await refreshProfiles()
    return result
  }

  const updateProfilePin = async (profileId, pin) => {
    const result = await setCollectorProfilePin(profileId, pin)
    await refreshProfiles()
    return result
  }

  const removeProfile = async (profileId, confirmUsername) => {
    const result = await deleteCollectorProfile(profileId, confirmUsername)
    await refreshProfiles()
    return result
  }

  const logout = () => {
    localStorage.removeItem('token')
    storeUser(null)
    setUser(null)
    setProfiles([])
    setActorUserId(null)
    window.location.href = '/login'
  }

  const value = {
    user,
    loading,
    multiUser,
    loginUser,
    updateCurrentUser,
    logout,
    profiles,
    actorUserId,
    profilesLoading,
    refreshProfiles,
    switchProfile,
    switchBack,
    createProfile,
    updateProfile,
    updateProfilePin,
    removeProfile,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export default AuthContext
