import { useEffect, useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'

export default function PhotoImportImage({ src, alt = '', className = '', ...props }) {
  const [resolvedSrc, setResolvedSrc] = useState(src && !src.startsWith('/api/') ? src : null)
  const [loading, setLoading] = useState(Boolean(src?.startsWith('/api/')))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    let objectUrl = null
    setFailed(false)

    if (!src) {
      setResolvedSrc(null)
      setLoading(false)
      return () => {}
    }
    if (!src.startsWith('/api/')) {
      setResolvedSrc(src)
      setLoading(false)
      return () => {}
    }

    setLoading(true)
    const token = localStorage.getItem('token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    fetch(src, { headers })
      .then(response => {
        if (!response.ok) throw new Error(`Image request failed: ${response.status}`)
        return response.blob()
      })
      .then(blob => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setResolvedSrc(objectUrl)
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setFailed(true)
        setLoading(false)
      })

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  if (loading) {
    return (
      <div className={`flex items-center justify-center bg-bg-elevated ${className}`}>
        <Loader2 size={22} className="animate-spin text-text-muted" />
      </div>
    )
  }
  if (failed || !resolvedSrc) {
    return (
      <div className={`flex items-center justify-center bg-bg-elevated text-text-muted ${className}`}>
        <ImageOff size={22} />
      </div>
    )
  }
  return <img src={resolvedSrc} alt={alt} className={className} {...props} />
}
