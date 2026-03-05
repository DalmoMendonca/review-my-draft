/**
 * Netlify Function: /.netlify/functions/workshop
 * Expects:
 * {
 *   text: string (<=20000),
 *   persona: string,
 *   suggestion: { id,start,end,source_text,replacement,comment,kind,severity },
 *   user_reply: string,
 *   thread: [{ role: 'user'|'assistant', text: string }]
 * }
 * Returns:
 * { assistant_reply: string, updated_suggestion: { replacement, comment } | null }
 */

// Environment/configuration.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const OPENAI_WORKSHOP_MODEL = process.env.OPENAI_WORKSHOP_MODEL || OPENAI_MODEL
const OPENAI_MODEL_FALLBACKS = (process.env.OPENAI_MODEL_FALLBACKS || 'gpt-4o-mini')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
const WORKSHOP_TIMEOUT_MS = Number(process.env.WORKSHOP_TIMEOUT_MS || 26000)

const MAX_CHARS = 20000
const MAX_USER_REPLY = 1800
const MAX_THREAD_MESSAGES = 12

// Short persona profiles used for workshop tone + priorities.
const PERSONA_PROMPTS = {
  english_teacher: 'Candid, kind, and instructional. Prioritize clarity, correctness, and teachable edits.',
  college_professor: 'Rigorous and analytical. Prioritize argument quality, precision, structure, and logic.',
  fortune500_ceo: 'Direct and strategic. Prioritize concision, decision-readiness, and audience impact.',
  walt_whitman: 'Lyrical but clear. Prioritize cadence, imagery, breath, and voice without archaic imitation.',
  grammarian: 'Technical and precise. Prioritize grammar, agreement, syntax, punctuation, and consistency.',
  persuasive_writer: 'Audience-aware and forceful. Prioritize persuasion, momentum, and stronger claims.'
}

// HTTP helpers.
function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(payload)
  }
}

function jsonError(statusCode, message, extra = {}) {
  return jsonResponse(statusCode, { error: message, ...extra })
}

function parseJsonSafe(raw) {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function extractUpstreamErrorMessage(raw) {
  const parsed = parseJsonSafe(raw)
  const msg = parsed?.error?.message || parsed?.message
  return typeof msg === 'string' && msg.trim() ? msg.trim() : ''
}

// OpenAI request shaping for model families with different token fields.
function modelUsesMaxCompletionTokens(model) {
  const normalized = String(model || '').toLowerCase()
  return (
    normalized.startsWith('gpt-5') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  )
}

function buildCompletionRequestBody({ model, messages }) {
  const payload = {
    model,
    messages,
    response_format: { type: 'json_object' }
  }

  if (modelUsesMaxCompletionTokens(model)) {
    payload.max_completion_tokens = 1100
  } else {
    payload.max_tokens = 1100
    payload.temperature = 0.3
  }

  return payload
}

// Context helpers for line-aware workshop prompts.
function splitLinesWithOffsets(text) {
  const lines = []
  let start = 0
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      lines.push({
        start,
        end: i,
        text: text.slice(start, i)
      })
      start = i + 1
    }
  }
  return lines.length ? lines : [{ start: 0, end: 0, text: '' }]
}

function findLineIndex(lines, offset) {
  const safeOffset = Math.max(0, Math.min(offset, lines[lines.length - 1].end))
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (safeOffset >= line.start && safeOffset <= line.end) {
      return i
    }
  }
  return Math.max(0, lines.length - 1)
}

function buildFocusedContext(text, start, end, radius = 2) {
  const lines = splitLinesWithOffsets(text)
  const focusIndex = findLineIndex(lines, start)
  const from = Math.max(0, focusIndex - radius)
  const to = Math.min(lines.length - 1, focusIndex + radius)

  const contextLines = []
  for (let i = from; i <= to; i += 1) {
    const prefix = i === focusIndex ? '>>' : '  '
    contextLines.push(`${prefix} ${String(i + 1).padStart(3, ' ')} | ${lines[i].text}`)
  }

  const selected = text.slice(start, end)
  return {
    selected,
    context: contextLines.join('\n')
  }
}

// Input normalization to keep API payloads bounded and predictable.
function normalizeThread(thread) {
  if (!Array.isArray(thread)) return []
  const cleaned = []
  for (const item of thread.slice(-MAX_THREAD_MESSAGES)) {
    if (!item || typeof item !== 'object') continue
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!text) continue
    cleaned.push({ role, text: text.slice(0, 1800) })
  }
  return cleaned
}

function normalizeSuggestion(rawSuggestion, text) {
  if (!rawSuggestion || typeof rawSuggestion !== 'object') return null

  const start = Math.max(0, Math.min(text.length, Number(rawSuggestion.start) || 0))
  const end = Math.max(start + 1, Math.min(text.length, Number(rawSuggestion.end) || start + 1))
  const sourceText = text.slice(start, end)
  if (!sourceText.trim()) return null

  return {
    id: typeof rawSuggestion.id === 'string' ? rawSuggestion.id : '',
    start,
    end,
    source_text: sourceText,
    replacement: typeof rawSuggestion.replacement === 'string' ? rawSuggestion.replacement : '',
    comment: typeof rawSuggestion.comment === 'string' ? rawSuggestion.comment : '',
    kind: rawSuggestion.kind === 'comment' ? 'comment' : 'edit',
    severity: ['note', 'suggestion', 'important'].includes(rawSuggestion.severity)
      ? rawSuggestion.severity
      : 'note'
  }
}

// Prompt builder for one suggestion-level workshop exchange.
function buildWorkshopPrompt({ text, personaKey, suggestion, userReply, thread }) {
  const persona = PERSONA_PROMPTS[personaKey] || PERSONA_PROMPTS.english_teacher
  const focused = buildFocusedContext(text, suggestion.start, suggestion.end, 3)
  const threadBlock = thread.length
    ? thread.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n')
    : '(no prior workshop messages)'

  return [
    {
      role: 'system',
      content: [
        'You are a live revision workshop assistant collaborating on one suggestion.',
        'Return only valid JSON and no extra prose.',
        '',
        'Output schema:',
        '{',
        '  "assistant_reply": string,',
        '  "updated_suggestion": {',
        '    "replacement": string,',
        '    "comment": string',
        '  } | null',
        '}',
        '',
        'Rules:',
        '- Respond directly to the user message and explain your reasoning briefly.',
        '- If you revise the suggestion, keep it safe for the same span; do not change start/end.',
        '- Never return a clipped-word replacement or a no-op replacement.',
        '- If no revision is needed, set updated_suggestion to null.',
        '- Preserve persona perspective in tone and priorities.',
        '',
        `Persona profile: ${persona}`
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'Draft (full):',
        text,
        '',
        'Focused context (highlight line + surrounding lines):',
        focused.context,
        '',
        'Original suggestion:',
        JSON.stringify(suggestion),
        '',
        'Current selected text:',
        focused.selected,
        '',
        'Workshop thread so far:',
        threadBlock,
        '',
        'User reply:',
        userReply
      ].join('\n')
    }
  ]
}

// Single upstream request attempt.
async function callOpenAIOnce({ model, messages }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), WORKSHOP_TIMEOUT_MS)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildCompletionRequestBody({ model, messages })),
      signal: controller.signal
    })

    const raw = await res.text()
    if (!res.ok) return { ok: false, status: res.status, raw, model }
    return { ok: true, raw, model }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, status: 504, raw: 'Workshop request timed out.', model }
    }
    return {
      ok: false,
      status: 502,
      raw: typeof error?.message === 'string' ? error.message : 'Network failure contacting OpenAI.',
      model
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

// Parse assistant JSON from the chat.completions envelope.
function extractModelJson(rawEnvelope) {
  let envelope
  try {
    envelope = JSON.parse(rawEnvelope)
  } catch {
    return { ok: false, error: 'Failed to parse OpenAI response envelope.', details: String(rawEnvelope || '').slice(0, 600) }
  }

  const content = envelope?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: 'Model returned empty workshop response.', details: JSON.stringify(envelope).slice(0, 600) }
  }

  const trimmed = content.trim()
  try {
    return { ok: true, obj: JSON.parse(trimmed) }
  } catch {
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return { ok: true, obj: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) }
      } catch {
        return { ok: false, error: 'Failed to parse JSON returned by model.', details: trimmed.slice(0, 600) }
      }
    }
    return { ok: false, error: 'Model did not return a JSON object.', details: trimmed.slice(0, 600) }
  }
}

// Final response normalization before returning to client.
function normalizeWorkshopResult(obj, suggestion) {
  const assistantReply =
    typeof obj?.assistant_reply === 'string' && obj.assistant_reply.trim()
      ? obj.assistant_reply.trim()
      : 'I can clarify that suggestion further if you share what feels off.'

  const updated = obj?.updated_suggestion
  if (!updated || typeof updated !== 'object') {
    return { assistant_reply: assistantReply, updated_suggestion: null }
  }

  const replacement =
    typeof updated.replacement === 'string' ? updated.replacement.slice(0, 1200) : suggestion.replacement
  const comment = typeof updated.comment === 'string' ? updated.comment.slice(0, 700) : suggestion.comment

  const changed = replacement !== suggestion.replacement || comment !== suggestion.comment
  if (!changed || replacement === suggestion.source_text) {
    return { assistant_reply: assistantReply, updated_suggestion: null }
  }

  return {
    assistant_reply: assistantReply,
    updated_suggestion: {
      replacement,
      comment
    }
  }
}

// Main Netlify handler.
export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return jsonError(405, 'Method not allowed.')
    }

    if (!OPENAI_API_KEY) {
      return jsonError(500, 'Missing OPENAI_API_KEY in environment.')
    }

    let payload = {}
    try {
      payload = JSON.parse(event.body || '{}')
    } catch {
      payload = {}
    }

    const rawText = typeof payload?.text === 'string' ? payload.text : ''
    const text = rawText.slice(0, MAX_CHARS)
    const persona = String(payload?.persona || 'english_teacher')
    const userReply = typeof payload?.user_reply === 'string' ? payload.user_reply.trim().slice(0, MAX_USER_REPLY) : ''
    const thread = normalizeThread(payload?.thread)
    const suggestion = normalizeSuggestion(payload?.suggestion, text)

    if (!text.trim()) return jsonError(400, 'No draft text provided.')
    if (rawText.length > MAX_CHARS) return jsonError(400, `Text exceeds ${MAX_CHARS} characters.`)
    if (!userReply) return jsonError(400, 'No workshop reply provided.')
    if (!suggestion) return jsonError(400, 'Invalid suggestion payload.')

    const messages = buildWorkshopPrompt({
      text,
      personaKey: persona,
      suggestion,
      userReply,
      thread
    })

    const models = Array.from(new Set([OPENAI_WORKSHOP_MODEL, ...OPENAI_MODEL_FALLBACKS].filter(Boolean)))
    let lastFailure = null

    for (const model of models) {
      const upstream = await callOpenAIOnce({ model, messages })
      if (!upstream.ok) {
        lastFailure = upstream
        continue
      }

      const extracted = extractModelJson(upstream.raw)
      if (!extracted.ok) {
        lastFailure = { ok: false, status: 502, raw: extracted.details || extracted.error, model }
        continue
      }

      return jsonResponse(200, normalizeWorkshopResult(extracted.obj, suggestion))
    }

    const statusCode = lastFailure?.status === 504 ? 504 : 502
    const upstreamMessage = extractUpstreamErrorMessage(lastFailure?.raw)
    return jsonError(statusCode, upstreamMessage || 'Workshop request failed.', {
      model: lastFailure?.model || OPENAI_WORKSHOP_MODEL,
      details: String(lastFailure?.raw || '').slice(0, 600)
    })
  } catch (error) {
    return jsonError(500, 'Unexpected server error.', {
      details: typeof error?.message === 'string' ? error.message : 'Unknown error'
    })
  }
}
