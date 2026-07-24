import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, Image,
  Loader2, RotateCcw, Search, Sparkles, Trash2, Upload, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import {
  analyzePhotoImportImage,
  commitPhotoImport,
  createPhotoImport,
  deletePhotoImport,
  deletePhotoImportImage,
  getApiErrorMessage,
  getPhotoImport,
  getPhotoImportSummary,
  listPhotoImports,
  updatePhotoImport,
  updatePhotoImportItem,
  uploadPhotoImportImage,
} from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'
import PhotoImportImage from '../components/PhotoImportImage'
import CardMatchPicker from '../components/CardMatchPicker'

const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']
const VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']
const FILTERS = ['needs_review', 'unresolved', 'accepted', 'excluded', 'all']
const PAGE_SIZE = 36
const STORAGE_KEY = 'photo_import_session_id'

function confidenceClass(item) {
  if (item.identity_state === 'manual') return 'badge-blue'
  if (item.status === 'unresolved') return 'badge-red'
  if (item.needs_review) return 'badge-yellow'
  return 'badge-green'
}

function selectedCard(item) {
  return item.selected_card || item.candidates?.find(card => card.id === (item.selected_card_id || item.proposed_card_id)) || null
}

function ReviewItem({ item, t, onUpdate, onChangeCard, onZoom, busy }) {
  const match = selectedCard(item)
  return (
    <article className="rounded-2xl border border-border bg-bg-card p-3 shadow-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)] items-start gap-2">
        <button type="button" onClick={() => onZoom(item.crop_url)} className="min-w-0 text-left">
          <PhotoImportImage
            src={item.crop_url}
            alt={t('photoImport.sourceCrop')}
            className="mx-auto aspect-[2.5/3.5] w-full max-w-40 rounded-xl object-cover"
          />
          <p className="mt-1 text-center text-[10px] uppercase tracking-wider text-text-muted">
            {t('photoImport.sourceCrop')} · {item.slot}
          </p>
        </button>
        <div className="flex h-full items-center justify-center text-text-muted">⇄</div>
        <button type="button" onClick={() => match?.image && onZoom(match.image)} className="min-w-0 text-left">
          <PhotoImportImage
            src={match?.image}
            alt={match?.name || ''}
            className="mx-auto aspect-[2.5/3.5] w-full max-w-40 rounded-xl object-cover"
          />
          <p className="mt-1 truncate text-center text-[10px] uppercase tracking-wider text-text-muted">
            {t('photoImport.proposedMatch')}
          </p>
        </button>
      </div>

      <div className="mt-3 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-bold text-text-primary">{match?.name || item.recognized?.name || t('photoImport.noMatch')}</p>
            <p className="truncate text-xs font-mono text-brand-red/90">
              {`${(match?.set_abbreviation || match?.set_id || '').toUpperCase()} ${match?.number || item.recognized?.number || ''}`.trim() || '—'}
            </p>
            <p className="truncate text-xs text-text-secondary">{match?.set || item.recognized?.set_hint || '—'}</p>
          </div>
          <span className={`${confidenceClass(item)} flex-shrink-0 text-[10px]`}>
            {item.identity_state === 'manual' ? t('photoImport.manual') : `${item.identity_score || 0}/100`}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {(item.confidence_reasons || []).map(reason => (
            <span key={reason} className="badge-gray text-[10px]">{t(`photoImport.reasons.${reason}`)}</span>
          ))}
          {item.variant_state === 'review' && <span className="badge-yellow text-[10px]">{t('photoImport.foilUncertain')}</span>}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <select
            value={item.variant || 'Normal'}
            onChange={event => onUpdate(item.id, { variant: event.target.value })}
            disabled={busy}
            className="select py-1.5 text-xs"
          >
            {VARIANTS.map(variant => <option key={variant}>{variant}</option>)}
          </select>
          <select
            value={item.condition || 'NM'}
            onChange={event => onUpdate(item.id, { condition: event.target.value })}
            disabled={busy}
            className="select py-1.5 text-xs"
          >
            {CONDITIONS.map(condition => <option key={condition}>{condition}</option>)}
          </select>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => onUpdate(item.id, { status: 'accepted', variant: item.variant || 'Normal' })}
            disabled={busy || !match}
            className="btn-primary justify-center px-2 py-2 text-xs"
          >
            <Check size={14} /> {t('photoImport.accept')}
          </button>
          <button type="button" onClick={() => onChangeCard(item)} disabled={busy} className="btn-ghost justify-center px-2 py-2 text-xs">
            <Search size={14} /> {t('photoImport.change')}
          </button>
          <button
            type="button"
            onClick={() => onUpdate(item.id, { status: 'excluded' })}
            disabled={busy}
            className="btn-ghost justify-center px-2 py-2 text-xs text-text-muted"
          >
            <X size={14} /> {t('photoImport.exclude')}
          </button>
        </div>
      </div>
    </article>
  )
}

export default function PhotoImport() {
  const { t, settings } = useSettings()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileRef = useRef(null)
  const cameraRef = useRef(null)
  const [sessionId, setSessionId] = useState(() => localStorage.getItem(STORAGE_KEY))
  const [step, setStep] = useState('capture')
  const [layout, setLayout] = useState('3x3')
  const [defaultLang, setDefaultLang] = useState(settings.language === 'de' ? 'de' : 'en')
  const [defaultCondition, setDefaultCondition] = useState('NM')
  const [defaultVariant, setDefaultVariant] = useState('Normal')
  const [commitMode, setCommitMode] = useState('add')
  const [uploadProgress, setUploadProgress] = useState(null)
  const [filter, setFilter] = useState('needs_review')
  const [sort, setSort] = useState('confidence')
  const [page, setPage] = useState(1)
  const [pickerItem, setPickerItem] = useState(null)
  const [zoomSrc, setZoomSrc] = useState(null)

  const openSessionsQuery = useQuery({
    queryKey: ['photo-imports', 'open'],
    queryFn: () => listPhotoImports(),
    enabled: !sessionId,
    staleTime: 10_000,
  })

  useEffect(() => {
    const existing = openSessionsQuery.data?.[0]
    if (!sessionId && existing?.id) {
      setSessionId(existing.id)
      localStorage.setItem(STORAGE_KEY, existing.id)
    }
  }, [openSessionsQuery.data, sessionId])

  const sessionQuery = useQuery({
    queryKey: ['photo-import', sessionId],
    queryFn: () => getPhotoImport(sessionId),
    enabled: Boolean(sessionId),
    refetchOnWindowFocus: false,
  })
  const session = sessionQuery.data

  useEffect(() => {
    if (!session) return
    setDefaultLang(session.default_lang)
    setDefaultCondition(session.default_condition)
    setDefaultVariant(session.default_variant)
    setCommitMode(session.commit_mode)
  }, [session?.id])

  const createMutation = useMutation({
    mutationFn: () => createPhotoImport({
      layout,
      default_lang: defaultLang,
      default_condition: defaultCondition,
      default_variant: defaultVariant,
      commit_mode: commitMode,
    }),
    onSuccess: data => {
      setSessionId(data.id)
      localStorage.setItem(STORAGE_KEY, data.id)
      queryClient.setQueryData(['photo-import', data.id], data)
      toast.success(t('photoImport.sessionCreated'))
    },
    onError: error => toast.error(getApiErrorMessage(error, t('photoImport.createFailed'))),
  })

  const updateSessionMutation = useMutation({
    mutationFn: data => updatePhotoImport(sessionId, data),
    onSuccess: data => queryClient.setQueryData(['photo-import', sessionId], data),
    onError: error => toast.error(getApiErrorMessage(error, t('common.error'))),
  })

  const itemMutation = useMutation({
    mutationFn: ({ itemId, data }) => updatePhotoImportItem(sessionId, itemId, data),
    onSuccess: data => queryClient.setQueryData(['photo-import', sessionId], data),
    onError: error => toast.error(getApiErrorMessage(error, t('common.error'))),
  })

  const deleteSessionMutation = useMutation({
    mutationFn: () => deletePhotoImport(sessionId),
    onSuccess: () => {
      localStorage.removeItem(STORAGE_KEY)
      setSessionId(null)
      setStep('capture')
      queryClient.removeQueries({ queryKey: ['photo-import'] })
    },
  })

  const summaryQuery = useQuery({
    queryKey: ['photo-import', sessionId, 'summary', session?.commit_mode, session?.updated_at],
    queryFn: () => getPhotoImportSummary(sessionId),
    enabled: Boolean(sessionId && step === 'summary'),
  })

  const commitMutation = useMutation({
    mutationFn: () => commitPhotoImport(sessionId, { commit_mode: commitMode }),
    onSuccess: result => {
      toast.success(`${result.added + result.updated + result.unchanged} ${t('photoImport.entriesApplied')}`)
      localStorage.removeItem(STORAGE_KEY)
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === 'pokedex' })
      queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === 'card-search' })
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
      navigate('/collection')
    },
    onError: error => toast.error(getApiErrorMessage(error, t('photoImport.commitFailed'))),
  })

  const handleFiles = async filesValue => {
    const files = [...(filesValue || [])]
    if (!files.length || !sessionId) return
    for (let index = 0; index < files.length; index += 1) {
      setUploadProgress({ current: index + 1, total: files.length, name: files[index].name })
      try {
        const uploaded = await uploadPhotoImportImage(sessionId, files[index])
        queryClient.setQueryData(['photo-import', sessionId], uploaded)
        const image = uploaded.images[uploaded.images.length - 1]
        const analyzed = await analyzePhotoImportImage(sessionId, image.id)
        queryClient.setQueryData(['photo-import', sessionId], analyzed)
      } catch (error) {
        toast.error(`${files[index].name}: ${getApiErrorMessage(error, t('photoImport.analysisFailed'))}`)
      }
    }
    setUploadProgress(null)
    if (fileRef.current) fileRef.current.value = ''
    if (cameraRef.current) cameraRef.current.value = ''
    sessionQuery.refetch()
  }

  const handleDeleteImage = async imageId => {
    try {
      const updated = await deletePhotoImportImage(sessionId, imageId)
      queryClient.setQueryData(['photo-import', sessionId], updated)
    } catch (error) {
      toast.error(getApiErrorMessage(error, t('common.error')))
    }
  }

  const reviewItems = useMemo(() => {
    let rows = [...(session?.items || [])]
    if (filter === 'needs_review') rows = rows.filter(item => item.needs_review)
    else if (filter === 'unresolved') rows = rows.filter(item => item.status === 'unresolved')
    else if (filter !== 'all') rows = rows.filter(item => item.status === filter)

    rows.sort((a, b) => {
      if (sort === 'photo') return (a.image_order || 0) - (b.image_order || 0) || a.slot - b.slot
      if (sort === 'name') return (selectedCard(a)?.name || '').localeCompare(selectedCard(b)?.name || '')
      if (sort === 'set') return (selectedCard(a)?.set || '').localeCompare(selectedCard(b)?.set || '')
      return (a.identity_score || 0) - (b.identity_score || 0)
    })
    return rows
  }, [filter, session?.items, sort])

  useEffect(() => setPage(1), [filter, sort])
  const totalPages = Math.max(1, Math.ceil(reviewItems.length / PAGE_SIZE))
  const visibleReviewItems = reviewItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const updateItem = (itemId, data) => itemMutation.mutate({ itemId, data })

  const applyDefaults = () => updateSessionMutation.mutate({
    default_lang: defaultLang,
    default_condition: defaultCondition,
    default_variant: defaultVariant,
    commit_mode: commitMode,
    apply_defaults_to_unedited: true,
  })

  if (!sessionId) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 pb-12">
        <button type="button" onClick={() => navigate('/collection')} className="btn-ghost"><ArrowLeft size={16} /> {t('common.back')}</button>
        <div>
          <h1 className="text-2xl font-black text-text-primary">{t('photoImport.title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('photoImport.subtitle')}</p>
        </div>
        <div className="card space-y-4">
          <div>
            <label className="mb-1 block text-xs text-text-muted">{t('photoImport.layout')}</label>
            <div className="grid grid-cols-3 gap-2">
              {['3x3', '4x3', 'single'].map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setLayout(value)}
                  className={`rounded-xl border px-3 py-3 font-bold ${layout === value ? 'border-brand-red bg-brand-red/10 text-brand-red' : 'border-border text-text-secondary'}`}
                >
                  {value === 'single' ? t('photoImport.singleCard') : value}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div><label className="mb-1 block text-xs text-text-muted">{t('photoImport.defaultLanguage')}</label><TcgdexLanguageSelect value={defaultLang} onChange={setDefaultLang} className="select w-full" /></div>
            <div><label className="mb-1 block text-xs text-text-muted">{t('photoImport.defaultCondition')}</label><select className="select w-full" value={defaultCondition} onChange={event => setDefaultCondition(event.target.value)}>{CONDITIONS.map(value => <option key={value}>{value}</option>)}</select></div>
            <div><label className="mb-1 block text-xs text-text-muted">{t('photoImport.defaultVariant')}</label><select className="select w-full" value={defaultVariant} onChange={event => setDefaultVariant(event.target.value)}>{VARIANTS.map(value => <option key={value}>{value}</option>)}</select></div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-text-muted">{t('photoImport.commitMode')}</label>
            <select className="select w-full" value={commitMode} onChange={event => setCommitMode(event.target.value)}>
              <option value="add">{t('photoImport.addMode')}</option>
              <option value="set_scanned">{t('photoImport.setMode')}</option>
            </select>
            <p className="mt-1 text-xs text-text-muted">{commitMode === 'add' ? t('photoImport.addModeHelp') : t('photoImport.setModeHelp')}</p>
          </div>
          <button type="button" onClick={() => createMutation.mutate()} disabled={createMutation.isPending || openSessionsQuery.isLoading} className="btn-primary w-full justify-center py-3">
            {createMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />} {t('photoImport.startSession')}
          </button>
        </div>
      </div>
    )
  }

  if (sessionQuery.isLoading || !session) {
    return <div className="flex min-h-[50vh] items-center justify-center"><Loader2 size={30} className="animate-spin text-brand-red" /></div>
  }

  return (
    <div className="space-y-5 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button type="button" onClick={() => navigate('/collection')} className="mb-2 flex items-center gap-1 text-xs text-text-muted hover:text-text-primary"><ArrowLeft size={14} /> {t('nav.collection')}</button>
          <h1 className="text-2xl font-black text-text-primary">{t('photoImport.title')}</h1>
          <p className="text-sm text-text-secondary">{session.counts.items} {t('photoImport.cardsDetected')} · {session.counts.images} {t('photoImport.photos')}</p>
        </div>
        <button type="button" onClick={() => window.confirm(t('photoImport.deleteSessionConfirm')) && deleteSessionMutation.mutate()} className="btn-ghost text-sm text-text-muted"><Trash2 size={15} /> {t('photoImport.discardSession')}</button>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-xl bg-bg-elevated p-1">
        {[
          ['capture', t('photoImport.capture'), Image],
          ['review', t('photoImport.review'), Search],
          ['summary', t('photoImport.summary'), Check],
        ].map(([value, label, Icon]) => (
          <button key={value} type="button" onClick={() => setStep(value)} className={`flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-bold ${step === value ? 'bg-brand-red text-white' : 'text-text-secondary'}`}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {step === 'capture' && (
        <div className="space-y-4">
          <div className="card">
            <div
              className="mx-auto grid aspect-[3/4] w-full max-w-xs overflow-hidden rounded-2xl border-2 border-dashed border-brand-red/40 bg-brand-red/5"
              style={{
                gridTemplateColumns: `repeat(${session.layout === 'single' ? 1 : 3}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${session.layout === '4x3' ? 4 : session.layout === 'single' ? 1 : 3}, minmax(0, 1fr))`,
              }}
            >
              {Array.from({ length: session.layout === '4x3' ? 12 : session.layout === 'single' ? 1 : 9 }).map((_, index) => (
                <div key={index} className="flex items-center justify-center border border-white/10 text-xs text-text-muted">{index + 1}</div>
              ))}
            </div>
            <p className="mx-auto mt-3 max-w-lg text-center text-xs text-text-secondary">{t('photoImport.photoGuidance')}</p>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={event => handleFiles(event.target.files)} />
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={event => handleFiles(event.target.files)} />
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => cameraRef.current?.click()} disabled={Boolean(uploadProgress)} className="btn-primary justify-center py-3"><Camera size={18} /> {t('photoImport.takePhotos')}</button>
              <button type="button" onClick={() => fileRef.current?.click()} disabled={Boolean(uploadProgress)} className="btn-ghost justify-center py-3"><Upload size={18} /> {t('photoImport.uploadPhotos')}</button>
            </div>
            {uploadProgress && (
              <div className="mt-4 rounded-xl bg-bg-elevated p-3 text-sm text-text-secondary">
                <div className="flex items-center gap-2"><Loader2 size={17} className="animate-spin text-brand-red" /> {t('photoImport.processingPhoto')} {uploadProgress.current}/{uploadProgress.total}</div>
                <p className="mt-1 truncate text-xs text-text-muted">{uploadProgress.name}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {session.images.map(image => (
              <div key={image.id} className="rounded-2xl border border-border bg-bg-card p-3">
                <PhotoImportImage src={image.preview_url} alt={image.filename} className="aspect-[3/4] w-full rounded-xl object-cover" />
                <div className="mt-2 flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="truncate text-sm font-bold text-text-primary">{image.filename}</p><p className="text-xs text-text-muted">{image.slot_count - (image.empty_slots || 0)} {t('photoImport.occupiedSlots')}</p></div>
                  <span className={image.status === 'analyzed' ? 'badge-green' : image.status === 'failed' ? 'badge-red' : 'badge-yellow'}>{image.status}</span>
                </div>
                {image.error && <p className="mt-2 text-xs text-brand-red">{image.error}</p>}
                <button type="button" onClick={() => handleDeleteImage(image.id)} className="btn-ghost mt-2 w-full justify-center text-xs text-text-muted"><Trash2 size={13} /> {t('common.remove')}</button>
              </div>
            ))}
          </div>

          {session.counts.items > 0 && <button type="button" onClick={() => setStep('review')} className="btn-primary w-full justify-center py-3">{t('photoImport.reviewMatches')} <ChevronRight size={17} /></button>}
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-4">
          <div className="card space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {FILTERS.map(value => (
                <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${filter === value ? 'bg-brand-red text-white' : 'bg-bg-elevated text-text-secondary'}`}>
                  {t(`photoImport.filters.${value}`)}
                </button>
              ))}
              <select value={sort} onChange={event => setSort(event.target.value)} className="select ml-auto py-1.5 text-xs">
                <option value="confidence">{t('photoImport.sortConfidence')}</option>
                <option value="photo">{t('photoImport.sortPhoto')}</option>
                <option value="name">{t('common.name')}</option>
                <option value="set">{t('common.set')}</option>
              </select>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <TcgdexLanguageSelect value={defaultLang} onChange={setDefaultLang} className="select w-full" />
              <select value={defaultCondition} onChange={event => setDefaultCondition(event.target.value)} className="select">{CONDITIONS.map(value => <option key={value}>{value}</option>)}</select>
              <select value={defaultVariant} onChange={event => setDefaultVariant(event.target.value)} className="select">{VARIANTS.map(value => <option key={value}>{value}</option>)}</select>
              <button type="button" onClick={applyDefaults} disabled={updateSessionMutation.isPending} className="btn-ghost justify-center"><RotateCcw size={15} /> {t('photoImport.applyDefaults')}</button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleReviewItems.map(item => (
              <ReviewItem key={item.id} item={item} t={t} onUpdate={updateItem} onChangeCard={setPickerItem} onZoom={setZoomSrc} busy={itemMutation.isPending} />
            ))}
          </div>
          {reviewItems.length === 0 && <div className="card py-10 text-center text-sm text-text-muted">{t('photoImport.noItemsForFilter')}</div>}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <button type="button" onClick={() => setPage(value => Math.max(1, value - 1))} disabled={page === 1} className="btn-ghost p-2"><ChevronLeft size={18} /></button>
              <span className="text-sm text-text-secondary">{page} / {totalPages}</span>
              <button type="button" onClick={() => setPage(value => Math.min(totalPages, value + 1))} disabled={page === totalPages} className="btn-ghost p-2"><ChevronRight size={18} /></button>
            </div>
          )}
          <button type="button" onClick={() => setStep('summary')} className="btn-primary w-full justify-center py-3">{t('photoImport.reviewSummary')} <ChevronRight size={17} /></button>
        </div>
      )}

      {step === 'summary' && (
        <div className="space-y-4">
          <div className="card grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              [summaryQuery.data?.accepted_items || 0, t('photoImport.acceptedCards')],
              [summaryQuery.data?.unique_entries || 0, t('photoImport.uniqueEntries')],
              [summaryQuery.data?.scanned_copies || 0, t('photoImport.scannedCopies')],
              [summaryQuery.data?.excluded || 0, t('photoImport.excluded')],
              [summaryQuery.data?.unresolved || 0, t('photoImport.stillUnresolved')],
            ].map(([value, label]) => <div key={label}><p className="text-2xl font-black text-text-primary">{value}</p><p className="text-xs text-text-muted">{label}</p></div>)}
          </div>

          <div className="card">
            <label className="mb-1 block text-xs text-text-muted">{t('photoImport.commitMode')}</label>
            <select
              value={commitMode}
              onChange={event => {
                const value = event.target.value
                setCommitMode(value)
                updateSessionMutation.mutate({ commit_mode: value })
              }}
              className="select w-full"
            >
              <option value="add">{t('photoImport.addMode')}</option>
              <option value="set_scanned">{t('photoImport.setMode')}</option>
            </select>
            <p className="mt-1 text-xs text-text-muted">{commitMode === 'add' ? t('photoImport.addModeHelp') : t('photoImport.setModeHelp')}</p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-bg-card">
            <div className="max-h-[55vh] overflow-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="sticky top-0 bg-bg-elevated text-left text-xs text-text-muted">
                  <tr><th className="p-3">{t('photoImport.card')}</th><th className="p-3">{t('photoImport.version')}</th><th className="p-3 text-right">{t('photoImport.current')}</th><th className="p-3 text-right">{t('photoImport.scanned')}</th><th className="p-3 text-right">{t('photoImport.result')}</th></tr>
                </thead>
                <tbody>
                  {(summaryQuery.data?.rows || []).map(row => (
                    <tr key={`${row.card_id}-${row.lang}-${row.variant}-${row.condition}`} className="border-t border-border/60">
                      <td className="p-3"><div className="flex items-center gap-2"><PhotoImportImage src={row.card?.image} alt="" className="h-14 w-10 rounded object-cover" /><div><p className="font-bold text-text-primary">{row.card?.name || row.card_id}</p><p className="text-xs text-text-muted">{row.card?.set_abbreviation} {row.card?.number}</p></div></div></td>
                      <td className="p-3 text-xs text-text-secondary">{row.lang.toUpperCase()} · {row.variant} · {row.condition}</td>
                      <td className="p-3 text-right">{row.current_quantity}</td>
                      <td className="p-3 text-right">{row.scanned_quantity}</td>
                      <td className="p-3 text-right font-black text-brand-red">{row.result_quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <button
            type="button"
            onClick={() => window.confirm(t('photoImport.commitConfirm')) && commitMutation.mutate()}
            disabled={commitMutation.isPending || !summaryQuery.data?.accepted_items}
            className="btn-primary w-full justify-center py-4 text-base"
          >
            {commitMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />} {t('photoImport.applyCollectionUpdate')}
          </button>
        </div>
      )}

      {pickerItem && (
        <CardMatchPicker
          sessionId={sessionId}
          lang={pickerItem.lang || 'all'}
          candidates={pickerItem.candidates || []}
          onClose={() => setPickerItem(null)}
          onConfirm={card => {
            updateItem(pickerItem.id, { selected_card_id: card.id, lang: card.lang || pickerItem.lang })
            setPickerItem(null)
          }}
        />
      )}

      {zoomSrc && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/90 p-4" onClick={() => setZoomSrc(null)}>
          <PhotoImportImage src={zoomSrc} alt="" className="max-h-[92vh] max-w-full rounded-2xl object-contain" />
        </div>
      )}
    </div>
  )
}
