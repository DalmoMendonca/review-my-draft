import React, { useEffect, useMemo, useRef, useState } from 'react'
import { PERSONAS } from './personas.js'

// Global UI limits and timing knobs used for local UX progress feedback.
const MAX_CHARS = 20000
const REQUEST_TIMEOUT_MS = 120000
const CHUNK_TRIGGER_CHARS = 8000
const CHUNK_TARGET_CHARS = 4200
const CHUNK_OVERLAP_CHARS = 280
const CHUNK_MAX = 6

// These helpers estimate progress so users see meaningful loading stages
// instead of a static spinner during long multi-chunk reviews.
function estimateChunkCount(textLength) {
  if (textLength < CHUNK_TRIGGER_CHARS) return 1
  const stride = Math.max(1, CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS)
  const extraChars = Math.max(0, textLength - CHUNK_TARGET_CHARS)
  const estimate = 1 + Math.ceil(extraChars / stride)
  return Math.max(2, Math.min(CHUNK_MAX, estimate))
}

function estimateExpectedDurationMs(textLength, chunkCount) {
  if (chunkCount <= 1) {
    return Math.min(28000, 7000 + Math.floor(textLength / 18))
  }

  return Math.min(65000, 10500 + chunkCount * 4200 + Math.floor(textLength / 26))
}

function formatElapsed(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function getStageLabel(progress, chunkCount) {
  if (chunkCount <= 1) {
    if (progress < 0.18) return 'Preparing review...'
    if (progress < 0.48) return 'Analyzing structure...'
    if (progress < 0.82) return 'Drafting inline edits...'
    return 'Finalizing comments...'
  }

  if (progress < 0.12) return 'Preparing review...'
  if (progress < 0.24) return `Splitting into ${chunkCount} sections...`
  if (progress < 0.86) {
    const sectionProgress = (progress - 0.24) / 0.62
    const section = Math.min(chunkCount, Math.max(1, Math.floor(sectionProgress * chunkCount) + 1))
    return `Reviewing section ${section} of ${chunkCount}...`
  }
  return 'Merging section feedback...'
}

function buildProgressSnapshot({ startedAt, expectedMs, chunkCount }) {
  const elapsedMs = Math.max(0, Date.now() - startedAt)
  const progress = Math.min(0.97, elapsedMs / expectedMs)

  return {
    percent: Math.max(2, Math.round(progress * 100)),
    stage: getStageLabel(progress, chunkCount),
    elapsedSeconds: Math.floor(elapsedMs / 1000),
    chunkCount
  }
}

// Generic utilities used by both review and workshop flows.
function clampText(value) {
  if (typeof value !== 'string') return ''
  return value.slice(0, MAX_CHARS)
}

function isProbablyMobile() {
  return window.matchMedia && window.matchMedia('(max-width: 860px)').matches
}

function applyTextReplacement(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end)
}

function isWordChar(ch) {
  return typeof ch === 'string' && /[A-Za-z0-9]/.test(ch)
}

function hasMidWordBoundaries(text, start, end) {
  const startsMidWord = start > 0 && isWordChar(text[start - 1]) && isWordChar(text[start])
  const endsMidWord = end < text.length && isWordChar(text[end - 1]) && isWordChar(text[end])
  return startsMidWord || endsMidWord
}

function normalizeSuggestions(raw) {
  if (!raw || typeof raw !== 'object') return { suggestions: [], overall: '' }

  const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : []
  const cleaned = []

  for (const s of suggestions) {
    if (!s) continue

    const start = Number(s.start)
    const end = Number(s.end)

    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start < 0 || end <= start) continue

    cleaned.push({
      id: typeof s.id === 'string' && s.id ? s.id : crypto.randomUUID(),
      start,
      end,
      sourceText: typeof s.source_text === 'string' ? s.source_text : '',
      replacement: typeof s.replacement === 'string' ? s.replacement : '',
      comment: typeof s.comment === 'string' ? s.comment : '',
      kind: typeof s.kind === 'string' ? s.kind.toLowerCase() : 'edit',
      severity: typeof s.severity === 'string' ? s.severity.toLowerCase() : 'note'
    })
  }

  cleaned.sort((a, b) => a.start - b.start)

  return {
    suggestions: cleaned,
    overall: typeof raw.overall_feedback === 'string' ? raw.overall_feedback : ''
  }
}

function buildSegments(text, suggestions) {
  const segs = []
  let idx = 0

  for (const s of suggestions) {
    if (s.start < idx) continue
    if (s.start > text.length || s.end > text.length) continue

    if (s.start > idx) {
      segs.push({ t: text.slice(idx, s.start), mark: null })
    }

    segs.push({ t: text.slice(s.start, s.end), mark: s.id })
    idx = s.end
  }

  if (idx < text.length) {
    segs.push({ t: text.slice(idx), mark: null })
  }

  return segs
}

function parseJsonSafely(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Workshop thread helpers keep API payloads predictable and UI-safe.
function normalizeThreadPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      assistantReply: 'I could not process that. Try again.',
      updatedSuggestion: null,
      stance: 'defend',
      authorIntentAcknowledged: false,
      reasoning: ''
    }
  }

  const assistantReply =
    typeof raw.assistant_reply === 'string' && raw.assistant_reply.trim()
      ? raw.assistant_reply.trim()
      : 'I could not process that. Try again.'
  const stanceRaw = typeof raw.stance === 'string' ? raw.stance.trim().toLowerCase() : ''
  const stance =
    stanceRaw === 'withdraw' || stanceRaw === 'optional_alternative' || stanceRaw === 'defend'
      ? stanceRaw
      : 'defend'
  const authorIntentAcknowledged = raw.author_intent_acknowledged === true
  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.trim().slice(0, 400) : ''

  const updatedRaw = raw.updated_suggestion
  const updatedSuggestion =
    updatedRaw && typeof updatedRaw === 'object'
      ? {
          replacement: typeof updatedRaw.replacement === 'string' ? updatedRaw.replacement : '',
          comment: typeof updatedRaw.comment === 'string' ? updatedRaw.comment : ''
        }
      : null

  return { assistantReply, updatedSuggestion, stance, authorIntentAcknowledged, reasoning }
}

function workshopStatusMeta(suggestion) {
  if (suggestion?.workshopStatus === 'withdrawn') {
    return {
      label: 'Suggestion withdrawn (author intent accepted)',
      tone: 'withdrawn'
    }
  }
  if (suggestion?.workshopStatus === 'optional_alternative') {
    return {
      label: 'Optional alternative after workshop',
      tone: 'optional'
    }
  }
  if (suggestion?.workshopStatus === 'defended') {
    return {
      label: 'Suggestion still recommended',
      tone: 'defended'
    }
  }
  return null
}

function createDefaultThreadState() {
  return {
    open: false,
    input: '',
    messages: [],
    loading: false,
    error: ''
  }
}

// Lightweight pulse animation helper used when jumping between mark/comment.
function triggerPulse(node, className) {
  if (!node) return
  node.classList.remove(className)
  void node.offsetWidth
  node.classList.add(className)
  setTimeout(() => node.classList.remove(className), 900)
}

function PersonaIcon({ name }) {
  switch (name) {
    case 'professor':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3 9 12 4l9 5-9 5-9-5Z" />
          <path d="M7 12v3c0 1.9 2.4 3.5 5 3.5s5-1.6 5-3.5v-3" />
        </svg>
      )
    case 'ceo':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M3.5 20.5h17" />
          <path d="M5.5 20.5V8.5h13v12" />
          <path d="M9 8.5V5.5h6v3" />
          <path d="M9 12h.01M12 12h.01M15 12h.01M9 15h.01M12 15h.01M15 15h.01" />
        </svg>
      )
    case 'poet':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 18h4l8.8-8.8a3.2 3.2 0 0 0-4.5-4.5L4.5 13.5V18Z" />
          <path d="m10.4 7.6 5.9 5.9" />
          <path d="M7 15h2" />
        </svg>
      )
    case 'grammarian':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4.5 6.5h9" />
          <path d="M4.5 11.5h9" />
          <path d="M4.5 16.5h7" />
          <path d="m15.2 11.6 1.8 1.8 3.2-3.5" />
          <circle cx="16.8" cy="18.3" r="1.2" />
          <path d="M16.7 19.5c0 .9-.4 1.6-1.2 2.1" />
        </svg>
      )
    case 'writer':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="m4 16 8-8 4 4-8 8H4v-4Z" />
          <path d="m14.5 5.5 2-2a1.8 1.8 0 0 1 2.6 0l1.4 1.4a1.8 1.8 0 0 1 0 2.6l-2 2" />
        </svg>
      )
    case 'teacher':
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="8" r="3" />
          <path d="M6 19c1.2-3 3.4-4.5 6-4.5s4.8 1.5 6 4.5" />
        </svg>
      )
  }
}

// Bottom-right persona selector with animated fan-out options.
function PersonaMenu({ personaKey, setPersonaKey, disabled }) {
  const [open, setOpen] = useState(false)
  const current = PERSONAS.find((p) => p.key === personaKey) || PERSONAS[0]

  useEffect(() => {
    const onDoc = (e) => {
      if (!open) return
      const el = e.target
      if (!el.closest?.('[data-persona-menu]')) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [open])

  return (
    <div data-persona-menu className={`personaMenu ${open ? 'open' : ''}`}>
      <button
        className="personaPill"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current.blurb}
      >
        <span className="personaIcon" aria-hidden="true">
          <PersonaIcon name={current.icon} />
        </span>
        <span className="personaLabel">{current.label}</span>
      </button>

      <div className="personaFan" role="listbox" aria-label="Select persona">
        {PERSONAS.filter((p) => p.key !== current.key).map((p, i) => (
          <button
            key={p.key}
            className="personaOption"
            style={{ '--i': i }}
            disabled={disabled}
            onClick={() => {
              setPersonaKey(p.key)
              setOpen(false)
            }}
            title={p.blurb}
          >
            <span className="personaIcon" aria-hidden="true">
              <PersonaIcon name={p.icon} />
            </span>
            <span className="personaLabel">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ReviewButton({ onClick, disabled, label = 'Review My Draft' }) {
  return (
    <button className="reviewBtn" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  )
}

// Full-screen progress overlay while review API calls are running.
function LoadingOverlay({ show, progress }) {
  if (!show) return null

  const safeProgress = Math.max(0, Math.min(100, Number(progress?.percent) || 0))
  const stageText = progress?.stage || 'Reviewing...'
  const elapsed = progress?.elapsedSeconds || 0
  const chunkCount = progress?.chunkCount || 1

  return (
    <div className="overlay" role="status" aria-live="polite">
      <div className="overlayCard">
        <div className="overlayHead">
          <div className="spinner" aria-hidden="true" />
          <div className="overlayCopy">
            <div className="overlayText">{stageText}</div>
            <div className="overlaySub">
              {chunkCount > 1 ? `${chunkCount} sections` : 'Single pass review'}
            </div>
          </div>
        </div>

        <div
          className="overlayProgress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={safeProgress}
          aria-label="Review progress"
        >
          <div className="overlayProgressFill" style={{ width: `${safeProgress}%` }} />
        </div>

        <div className="overlayMeta">
          <span>{safeProgress}%</span>
          <span>{formatElapsed(elapsed)}</span>
        </div>
      </div>
    </div>
  )
}

// Mobile comments UI: a bottom drawer that mirrors desktop margin comments.
function MobileDrawer({ open, onClose, children, title }) {
  return (
    <div className={`drawerWrap ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="drawerScrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawerTop">
          <div className="drawerTitle">{title}</div>
          <button className="drawerClose" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="drawerBody">{children}</div>
      </div>
    </div>
  )
}

export default function App() {
  // Draft session state.
  const [personaKey, setPersonaKey] = useState(PERSONAS[0].key)
  const [draft, setDraft] = useState('')
  const [locked, setLocked] = useState(false)

  // Review result state.
  const [review, setReview] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [overall, setOverall] = useState('')
  const [selectedMark, setSelectedMark] = useState(null)
  const [selectionOrigin, setSelectionOrigin] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [reviewProgress, setReviewProgress] = useState({
    percent: 0,
    stage: 'Preparing review...',
    elapsedSeconds: 0,
    chunkCount: 1
  })
  const [actionHistory, setActionHistory] = useState([])
  const [copied, setCopied] = useState(false)
  const [commentThreads, setCommentThreads] = useState({})

  // Responsive UI state.
  const [mobileCommentsOpen, setMobileCommentsOpen] = useState(false)
  const [mobileMode, setMobileMode] = useState(false)

  // Refs for stable values across async handlers.
  const editorRef = useRef(null)
  const draftRef = useRef(draft)
  const copyResetTimerRef = useRef(null)

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    setMobileMode(isProbablyMobile())

    const onResize = () => {
      setMobileMode(isProbablyMobile())
    }

    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => editorRef.current?.focus?.(), 50)
    return () => clearTimeout(t)
  }, [])

  useEffect(
    () => () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
      }
    },
    []
  )

  useEffect(() => {
    const onKeyDown = (event) => {
      const isUndoKey =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        typeof event.key === 'string' &&
        event.key.toLowerCase() === 'z'

      if (!isUndoKey) return
      if (!review || locked || !actionHistory.length) return

      event.preventDefault()
      setActionHistory((prev) => {
        if (!prev.length) return prev
        const previous = prev[prev.length - 1]
        setDraft(previous.draft)
        setSuggestions(previous.suggestions.map((item) => ({ ...item })))
        setSelectedMark(previous.selectedMark)
        setSelectionOrigin('undo')
        return prev.slice(0, -1)
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actionHistory.length, locked, review])

  useEffect(() => {
    if (!review) {
      setCommentThreads({})
      return
    }

    setCommentThreads((prev) => {
      const next = {}
      for (const suggestion of suggestions) {
        const existing = prev[suggestion.id]
        next[suggestion.id] = existing ? { ...existing } : createDefaultThreadState()
      }
      return next
    })
  }, [review, suggestions])

  const charCount = draft.length

  const segs = useMemo(() => {
    if (!review) return [{ t: draft, mark: null }]
    return buildSegments(draft, suggestions)
  }, [draft, review, suggestions])

  const commentList = useMemo(() => {
    if (!review) return []
    return suggestions
  }, [review, suggestions])

  async function requestReview() {
    const text = draftRef.current || ''
    if (!text.trim()) return

    const chunkCount = estimateChunkCount(text.length)
    const expectedMs = estimateExpectedDurationMs(text.length, chunkCount)
    const progressStart = Date.now()

    setLocked(true)
    setSelectedMark(null)
    setSelectionOrigin(null)
    setErrorMessage('')
    setActionHistory([])
    setCopied(false)
    setCommentThreads({})
    setReviewProgress(buildProgressSnapshot({ startedAt: progressStart, expectedMs, chunkCount }))

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const progressTimerId = setInterval(() => {
      setReviewProgress(buildProgressSnapshot({ startedAt: progressStart, expectedMs, chunkCount }))
    }, 280)

    try {
      // 1) Request review from server function.
      const res = await fetch('/.netlify/functions/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, persona: personaKey }),
        signal: controller.signal
      })

      const raw = await res.text()
      const payload = parseJsonSafely(raw)

      if (!res.ok) {
        const message = payload?.error || payload?.message || `Review failed (HTTP ${res.status}).`
        const detailText = typeof payload?.details === 'string' ? payload.details : ''
        const compactDetails = detailText.replace(/\s+/g, ' ').trim().slice(0, 220)
        const modelText = typeof payload?.model === 'string' ? ` [${payload.model}]` : ''
        const withDetails = compactDetails ? `${message}${modelText} ${compactDetails}` : `${message}${modelText}`
        throw new Error(withDetails)
      }

      if (!payload || typeof payload !== 'object') {
        throw new Error('Review service returned an unreadable response. Please retry.')
      }

      setReviewProgress((prev) => ({
        ...prev,
        percent: Math.max(prev.percent, 99),
        stage: 'Finalizing comments...'
      }))

      // 2) Normalize payload into strict UI shape.
      const normalized = normalizeSuggestions(payload)
      setReview(normalized)
      setSuggestions(normalized.suggestions)
      setOverall(normalized.overall)
      setActionHistory([])
      setCopied(false)
    } catch (error) {
      console.error(error)
      if (error?.name === 'AbortError') {
        setErrorMessage('Review timed out. Please try again.')
      } else {
        setErrorMessage(error?.message || 'Something went wrong.')
      }
    } finally {
      clearTimeout(timeoutId)
      clearInterval(progressTimerId)
      setLocked(false)
    }
  }

  function clearReview() {
    setReview(null)
    setSuggestions([])
    setOverall('')
    setSelectedMark(null)
    setSelectionOrigin(null)
    setMobileCommentsOpen(false)
    setErrorMessage('')
    setActionHistory([])
    setCopied(false)
    setCommentThreads({})
    setTimeout(() => editorRef.current?.focus?.(), 50)
  }

  // Save reversible snapshots so accept/decline actions support undo.
  function pushHistorySnapshot() {
    setActionHistory((prev) => {
      const snapshot = {
        draft,
        suggestions: suggestions.map((item) => ({ ...item })),
        selectedMark
      }

      const next = [...prev, snapshot]
      return next.length > 100 ? next.slice(next.length - 100) : next
    })
  }

  function undoLastAction() {
    if (locked) return

    setActionHistory((prev) => {
      if (!prev.length) return prev
      const previous = prev[prev.length - 1]
      setDraft(previous.draft)
      setSuggestions(previous.suggestions.map((item) => ({ ...item })))
      setSelectedMark(previous.selectedMark)
      setSelectionOrigin('undo')
      return prev.slice(0, -1)
    })
  }

  async function copyDraftToClipboard() {
    const text = draftRef.current || ''
    if (!text) return

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const fallback = document.createElement('textarea')
        fallback.value = text
        fallback.setAttribute('readonly', '')
        fallback.style.position = 'fixed'
        fallback.style.opacity = '0'
        document.body.appendChild(fallback)
        fallback.select()
        document.execCommand('copy')
        document.body.removeChild(fallback)
      }

      setCopied(true)
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = setTimeout(() => {
        setCopied(false)
      }, 1400)
    } catch {
      setErrorMessage('Copy failed. Please copy manually.')
    }
  }

  // Accept applies text replacement and shifts remaining suggestion offsets.
  function acceptSuggestion(id) {
    const s = suggestions.find((x) => x.id === id)
    if (!s) return
    if (s.workshopStatus === 'withdrawn') return

    const beforeText = draft
    const selectedText = beforeText.slice(s.start, s.end)
    const expectedSource = typeof s.sourceText === 'string' ? s.sourceText : ''
    const replacement = s.replacement || ''

    if (expectedSource && selectedText !== expectedSource) {
      setErrorMessage('Skipped an unsafe suggestion due to span mismatch.')
      declineSuggestion(id)
      return
    }

    if (s.kind === 'edit') {
      if (replacement === selectedText) {
        declineSuggestion(id)
        return
      }

      if (hasMidWordBoundaries(beforeText, s.start, s.end)) {
        setErrorMessage('Skipped an unsafe suggestion due to clipped word boundaries.')
        declineSuggestion(id)
        return
      }
    }

    pushHistorySnapshot()

    const afterText = applyTextReplacement(beforeText, s.start, s.end, replacement)
    const delta = replacement.length - (s.end - s.start)

    const next = []

    for (const other of suggestions) {
      if (other.id === id) continue

      const overlaps = !(other.end <= s.start || other.start >= s.end)
      if (overlaps) continue

      if (other.start >= s.end) {
        next.push({ ...other, start: other.start + delta, end: other.end + delta })
      } else {
        next.push(other)
      }
    }

    setDraft(afterText)
    setSuggestions(next)
    setSelectedMark(null)
    setSelectionOrigin(null)
  }

  function declineSuggestion(id) {
    const exists = suggestions.some((s) => s.id === id)
    if (!exists) return

    pushHistorySnapshot()
    setSuggestions((prev) => prev.filter((s) => s.id !== id))
    if (selectedMark === id) {
      setSelectedMark(null)
      setSelectionOrigin(null)
    }
  }

  // Workshop thread state updates per comment card.
  function toggleCommentThread(id) {
    setCommentThreads((prev) => {
      const current = prev[id] || createDefaultThreadState()
      return {
        ...prev,
        [id]: {
          ...current,
          open: !current.open,
          error: ''
        }
      }
    })
  }

  function updateCommentThreadInput(id, value) {
    setCommentThreads((prev) => {
      const current = prev[id] || createDefaultThreadState()
      return {
        ...prev,
        [id]: {
          ...current,
          input: value,
          error: ''
        }
      }
    })
  }

  async function sendCommentThreadMessage(id) {
    const suggestion = suggestions.find((item) => item.id === id)
    if (!suggestion || locked) return

    const thread = commentThreads[id] || createDefaultThreadState()
    const userMessage = thread.input.trim()
    if (!userMessage) return

    const optimisticMessages = [...thread.messages, { role: 'user', text: userMessage }]

    setCommentThreads((prev) => {
      const current = prev[id] || createDefaultThreadState()
      return {
        ...prev,
        [id]: {
          ...current,
          open: true,
          loading: true,
          error: '',
          input: '',
          messages: optimisticMessages
        }
      }
    })

    try {
      // Send full draft + selected suggestion + user reply to workshop function.
      const res = await fetch('/.netlify/functions/workshop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: draftRef.current || '',
          persona: personaKey,
          suggestion: {
            id: suggestion.id,
            start: suggestion.start,
            end: suggestion.end,
            source_text: suggestion.sourceText,
            replacement: suggestion.replacement,
            comment: suggestion.comment,
            kind: suggestion.kind,
            severity: suggestion.severity
          },
          user_reply: userMessage,
          thread: optimisticMessages
        })
      })

      const raw = await res.text()
      const payload = parseJsonSafely(raw)

      if (!res.ok) {
        const message = payload?.error || payload?.message || `Workshop failed (HTTP ${res.status}).`
        throw new Error(message)
      }

      const normalized = normalizeThreadPayload(payload)

      setCommentThreads((prev) => {
        const current = prev[id] || createDefaultThreadState()
        return {
          ...prev,
          [id]: {
            ...current,
            open: true,
            loading: false,
            error: '',
            messages: [...optimisticMessages, { role: 'assistant', text: normalized.assistantReply }]
          }
        }
      })

      // Persist workshop stance so users can see whether a suggestion was withdrawn.
      setSuggestions((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item

          const workshopStatus =
            normalized.stance === 'withdraw'
              ? 'withdrawn'
              : normalized.stance === 'optional_alternative'
                ? 'optional_alternative'
                : 'defended'
          const nextReplacement =
            normalized.updatedSuggestion && typeof normalized.updatedSuggestion.replacement === 'string'
              ? normalized.updatedSuggestion.replacement
              : item.replacement
          const nextComment =
            normalized.updatedSuggestion &&
            typeof normalized.updatedSuggestion.comment === 'string' &&
            normalized.updatedSuggestion.comment
              ? normalized.updatedSuggestion.comment
              : item.comment

          return {
            ...item,
            replacement: nextReplacement,
            comment: nextComment,
            workshopStatus,
            workshopReasoning: normalized.reasoning || '',
            workshopAcknowledgedIntent: normalized.authorIntentAcknowledged === true
          }
        })
      )
    } catch (error) {
      setCommentThreads((prev) => {
        const current = prev[id] || createDefaultThreadState()
        return {
          ...prev,
          [id]: {
            ...current,
            open: true,
            loading: false,
            error: error?.message || 'Workshop request failed.',
            input: userMessage,
            messages: thread.messages
          }
        }
      })
    }
  }

  function onDraftChange(e) {
    if (review || locked) return
    setDraft(clampText(e.target.value))
  }

  function jumpToMark(id, options = {}) {
    setSelectedMark(id)
    setSelectionOrigin(options.origin || 'comment')

    if (mobileMode && options.openCommentsOnMobile) {
      setMobileCommentsOpen(true)
    }

    const safeId = window.CSS?.escape ? window.CSS.escape(id) : String(id).replace(/"/g, '\\"')
    const el = document.querySelector(`[data-mark="${safeId}"]`)
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    triggerPulse(el, 'focusPulse')
  }

  const canReview = !locked && !review && !!draft.trim() && draft.length <= MAX_CHARS

  return (
    <div className="app">
      <LoadingOverlay show={locked} progress={reviewProgress} />

      <main className={`page ${review ? 'reviewMode' : 'draftMode'}`}>
        <div className="sheetWrap">
          <div className="sheet">
            <div className="sheetMeta">
              <div className="counter">
                <span>
                  {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
                </span>
              </div>
            </div>

            {!review ? (
              <textarea
                ref={editorRef}
                className="editorInput"
                value={draft}
                maxLength={MAX_CHARS}
                spellCheck
                placeholder="Start typing..."
                onChange={onDraftChange}
                aria-label="Draft editor"
              />
            ) : (
              <div className="doc">
                <div className="docBody" aria-label="Reviewed document">
                  {segs.map((s, idx) =>
                    s.mark ? (
                      <mark
                        key={idx}
                        className={`hl ${selectedMark === s.mark ? 'selected' : ''}`}
                        data-mark={s.mark}
                        onClick={() =>
                          jumpToMark(s.mark, { openCommentsOnMobile: true, origin: 'highlight' })
                        }
                        title="Click to view comment"
                      >
                        {s.t}
                      </mark>
                    ) : (
                      <span key={idx}>{s.t}</span>
                    )
                  )}
                </div>

                {overall.trim() ? (
                  <div className="overall">
                    <div className="overallLabel">Overall feedback</div>
                    <div className="overallText">{overall}</div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {errorMessage ? (
            <div className="errorMessage" role="alert">
              {errorMessage}
            </div>
          ) : null}
        </div>

        {review ? (
          mobileMode ? (
            <>
              <button className="mobileCommentsBtn" onClick={() => setMobileCommentsOpen(true)}>
                Comments ({commentList.length})
              </button>
              <MobileDrawer
                open={mobileCommentsOpen}
                onClose={() => setMobileCommentsOpen(false)}
                title={`Comments (${commentList.length})`}
              >
                <CommentsPanel
                  suggestions={commentList}
                  onJump={jumpToMark}
                  onAccept={acceptSuggestion}
                  onDecline={declineSuggestion}
                  threads={commentThreads}
                  onToggleThread={toggleCommentThread}
                  onThreadInput={updateCommentThreadInput}
                  onThreadSend={sendCommentThreadMessage}
                  selectedId={selectedMark}
                  selectedOrigin={selectionOrigin}
                />
              </MobileDrawer>
            </>
          ) : (
            <aside className="margin" aria-label="Margin comments">
              <CommentsPanel
                suggestions={commentList}
                onJump={jumpToMark}
                onAccept={acceptSuggestion}
                onDecline={declineSuggestion}
                threads={commentThreads}
                onToggleThread={toggleCommentThread}
                onThreadInput={updateCommentThreadInput}
                onThreadSend={sendCommentThreadMessage}
                selectedId={selectedMark}
                selectedOrigin={selectionOrigin}
              />
            </aside>
          )
        ) : null}

        <div className="controls" aria-label="Controls">
          {!review ? (
            <PersonaMenu
              personaKey={personaKey}
              setPersonaKey={setPersonaKey}
              disabled={locked || !!review}
            />
          ) : null}

          {review ? (
            <div className="reviewActions">
              <button
                className="iconBtn"
                onClick={undoLastAction}
                disabled={locked || !actionHistory.length}
                aria-label="Undo review action"
                title="Undo (Ctrl+Z)"
                type="button"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M10 8H4V2" />
                  <path d="M4 8c2.4-2.5 5.4-3.8 8.9-3.8 5.6 0 9.9 3.6 9.9 9.3S18.5 23 12.9 23c-3.1 0-5.8-1.1-7.8-3.2" />
                </svg>
              </button>

              <button
                className={`iconBtn ${copied ? 'copied' : ''}`}
                onClick={copyDraftToClipboard}
                disabled={locked || !draft.trim()}
                aria-label="Copy revised draft"
                title={copied ? 'Copied' : 'Copy draft'}
                type="button"
              >
                {copied ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M5 13.2 9.2 17 19 7.6" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <rect x="8" y="8" width="11" height="11" rx="2" />
                    <path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
                  </svg>
                )}
              </button>

              <ReviewButton onClick={clearReview} disabled={locked} label="New Draft" />
            </div>
          ) : (
            <ReviewButton onClick={requestReview} disabled={!canReview} />
          )}
        </div>
      </main>
    </div>
  )
}

// Shared comment renderer used by desktop margin and mobile drawer views.
function CommentsPanel({
  suggestions,
  onJump,
  onAccept,
  onDecline,
  threads,
  onToggleThread,
  onThreadInput,
  onThreadSend,
  selectedId,
  selectedOrigin
}) {
  const cardRefs = useRef(new Map())

  useEffect(() => {
    if (!selectedId) return
    if (selectedOrigin !== 'highlight') return
    const activeCard = cardRefs.current.get(selectedId)
    if (!activeCard) return

    activeCard.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    triggerPulse(activeCard, 'focusPulse')
  }, [selectedId, selectedOrigin, suggestions.length])

  if (!suggestions.length) {
    return <div className="commentsEmpty">No comments.</div>
  }

  return (
    <div className="comments">
      {suggestions.map((s) => {
        const thread = threads?.[s.id] || createDefaultThreadState()
        const status = workshopStatusMeta(s)
        const isWithdrawn = s.workshopStatus === 'withdrawn'

        return (
          <div
            key={s.id}
            ref={(node) => {
              if (node) {
                cardRefs.current.set(s.id, node)
              } else {
                cardRefs.current.delete(s.id)
              }
            }}
            className={`commentCard ${selectedId === s.id ? 'selected' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onJump(s.id, { openCommentsOnMobile: true, origin: 'comment' })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onJump(s.id, { openCommentsOnMobile: true, origin: 'comment' })
              }
            }}
          >
            <div className="commentTop">
              <div className="commentKind">{(s.kind || 'edit').toUpperCase()}</div>
              <div className="commentSeverity">{(s.severity || 'note').toUpperCase()}</div>
            </div>

            {s.comment ? <div className="commentBody">{s.comment}</div> : null}

            {status ? (
              <div className={`commentStatus ${status.tone}`}>
                <div className="commentStatusLabel">{status.label}</div>
                {s.workshopReasoning ? (
                  <div className="commentStatusReason">{s.workshopReasoning}</div>
                ) : null}
              </div>
            ) : null}

            {typeof s.replacement === 'string' ? (
              <div className="commentEdit">
                <div className="editLabel">Proposed text</div>
                <div className="editBox">{s.replacement || '(delete)'}</div>
              </div>
            ) : null}

            <div className="commentActions">
              <button
                className="btnGhost"
                onClick={(event) => {
                  event.stopPropagation()
                  onDecline(s.id)
                }}
              >
                Decline
              </button>
              <button
                className="btnSolid"
                disabled={isWithdrawn}
                onClick={(event) => {
                  event.stopPropagation()
                  onAccept(s.id)
                }}
              >
                {isWithdrawn ? 'Withdrawn' : 'Accept'}
              </button>
            </div>

            <div
              className="threadWrap"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <button
                className="threadToggle"
                type="button"
                onClick={() => onToggleThread(s.id)}
                aria-expanded={thread.open}
              >
                Workshop this suggestion
              </button>

              {thread.open ? (
                <div className="threadPanel">
                  {thread.messages.length ? (
                    <div className="threadList">
                      {thread.messages.map((m, idx) => (
                        <div key={`${s.id}-${idx}`} className={`threadMsg ${m.role}`}>
                          <div className="threadRole">{m.role === 'assistant' ? 'AI' : 'You'}</div>
                          <div className="threadText">{m.text}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="threadHint">
                      Ask for clarification, challenge the suggestion, or request an alternative rewrite.
                    </div>
                  )}

                  {thread.error ? (
                    <div className="threadError" role="alert">
                      {thread.error}
                    </div>
                  ) : null}

                  <textarea
                    className="threadInput"
                    value={thread.input}
                    placeholder="Reply to this comment..."
                    onChange={(event) => onThreadInput(s.id, event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                        event.preventDefault()
                        onThreadSend(s.id)
                      }
                    }}
                  />

                  <div className="threadActions">
                    <button
                      className="btnSolid"
                      type="button"
                      disabled={thread.loading || !thread.input.trim()}
                      onClick={() => onThreadSend(s.id)}
                    >
                      {thread.loading ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
