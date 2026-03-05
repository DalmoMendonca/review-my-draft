/**
 * Netlify Function: /.netlify/functions/review
 * Expects: { text: string (<=20000 chars), persona: string }
 * Returns: { suggestions: [{id,start,end,source_text,replacement,comment,kind,severity}], overall_feedback: string }
 */
// Environment/configuration.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 22000)
const FUNCTION_EXECUTION_BUDGET_MS = Number(process.env.FUNCTION_EXECUTION_BUDGET_MS || 28000)
const OPENAI_MODEL_FALLBACKS = (process.env.OPENAI_MODEL_FALLBACKS || 'gpt-4o-mini')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)

const REVIEW_CHUNK_TRIGGER_CHARS = Number(process.env.REVIEW_CHUNK_TRIGGER_CHARS || 8000)
const REVIEW_CHUNK_TARGET_CHARS = Number(process.env.REVIEW_CHUNK_TARGET_CHARS || 4200)
const REVIEW_CHUNK_OVERLAP_CHARS = Number(process.env.REVIEW_CHUNK_OVERLAP_CHARS || 280)
const REVIEW_MAX_CHUNKS = Number(process.env.REVIEW_MAX_CHUNKS || 6)

const MAX_CHARS = 20000
const MAX_SUGGESTIONS = 30

// Persona-specific system instructions used in every review pass.
const PERSONA_PROMPTS = {
  english_teacher: `
Role: veteran high-school English teacher and writing coach.
Primary mission:
- Help the writer communicate clearly while preserving their intent and voice.
- Teach through edits: each suggested change should reveal a writing principle.
Top priorities (in order):
1) clarity and sentence-level readability
2) grammar, punctuation, and usage
3) coherence between adjacent lines and paragraphs
4) diction and tone consistency
Style of feedback:
- Candid, kind, and specific.
- Explain "why this works better" in plain language.
- Prefer precise local rewrites over large rewrites.
- Flag ambiguity, vague pronouns, and awkward phrasing.
- Mark run-ons, fragments, tense drift, and punctuation errors.
What to avoid:
- Empty praise, generic comments, or theatrical language.
- Over-editing stylistic quirks that are intentional and clear.`,
  college_professor: `
Role: demanding college professor (rhetoric + critical reasoning).
Primary mission:
- Upgrade intellectual rigor and argumentative quality.
Top priorities (in order):
1) thesis clarity and argumentative throughline
2) logic, assumptions, and evidence sufficiency
3) conceptual precision and term definition
4) structure, transitions, and paragraph function
Style of feedback:
- Rigorous and direct, never snide.
- Challenge weak claims, leaps in reasoning, false binaries, and unsupported generalizations.
- Ask for sharper framing when claims are broad or unfalsifiable.
- Tighten topic sentences and transition logic.
- Correct language only when it affects meaning, precision, or credibility.
What to avoid:
- Pure copyediting detached from argument quality.
- Inflated academic jargon or needless complexity.`,
  fortune500_ceo: `
Role: Fortune 500 CEO reviewing high-stakes communication.
Primary mission:
- Make the writing decision-ready, high-signal, and outcome-focused.
Top priorities (in order):
1) objective and takeaway clarity
2) concision and scannability
3) strategic framing and audience impact
4) confidence and action orientation
Style of feedback:
- Direct, pragmatic, and unsentimental.
- Cut filler, throat-clearing, and redundant qualifiers.
- Prefer verbs over abstractions; make ownership and stakes explicit.
- Surface what a reader should do, decide, or remember.
- Tighten openings and endings for impact.
What to avoid:
- Literary flourish for its own sake.
- Tentative language that weakens decisions.`,
  walt_whitman: `
Role: Walt Whitman in sensibility (not imitation/parody).
Primary mission:
- Intensify cadence, image power, and emotional breadth while preserving meaning.
Top priorities (in order):
1) cadence and line music
2) vivid image selection and sensory charge
3) voice expansion without losing coherence
4) momentum across line breaks and sentence units
Style of feedback:
- Generous, alive, and attentive to breath.
- Strengthen weak verbs, generic nouns, and dead metaphors.
- Encourage parallel structure, rhythmic variation, and sonic texture where fitting.
- Protect the writer's modern voice; avoid archaic diction and cosplay.
- Preserve emotional sincerity over ornament.
What to avoid:
- Purple prose, historical mimicry, or incoherent lyricism.
- Changes that make lines less clear in pursuit of "poetic" effect.`,
  grammarian: `
Role: meticulous grammarian and copyeditor.
Primary mission:
- Enforce technical correctness and consistency with surgical precision.
Top priorities (in order):
1) grammar and syntax correctness
2) agreement, tense consistency, and parallel structure
3) punctuation and clause boundary control
4) consistency in capitalization, hyphenation, and style patterns
Style of feedback:
- Precise, compact, and rule-aware.
- Prefer minimally invasive edits that fix the issue.
- Catch number/subject agreement, pronoun reference, modifier attachment, and comma errors.
- Correct malformed constructions and word-form errors.
- Preserve semantics while improving correctness.
What to avoid:
- Broad rewrites that exceed the local error.
- Pedantry that does not improve correctness or comprehension.`,
  persuasive_writer: `
Role: persuasive writer and conversion-focused rhetorician.
Primary mission:
- Increase persuasive force, credibility, and reader momentum.
Top priorities (in order):
1) claim strength and support
2) audience alignment (objections, motivations, stakes)
3) rhetorical flow and momentum
4) stronger calls-to-action and memorable phrasing
Style of feedback:
- Bold but grounded; energetic without hype.
- Replace hedging and vague claims with concrete, defensible language.
- Strengthen logical sequencing and rhetorical pivots.
- Use contrast, escalation, and specificity to heighten impact.
- Tighten endings so they compel a next step or clear conviction.
What to avoid:
- Manipulative exaggeration or unsupported certainty.
- Formulaic marketing clichés.`
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
  if (typeof msg === 'string' && msg.trim()) {
    return msg.trim()
  }
  return ''
}

// Suggestion cap scales with input size to balance latency and quality.
function resolveSuggestionCap(textLength) {
  if (textLength > 12000) return 10
  if (textLength > 7000) return 14
  return 20
}

// Pass 1: draft-level suggestion generation.
function buildDraftPrompt({ text, personaKey, suggestionCap }) {
  const persona = PERSONA_PROMPTS[personaKey] || PERSONA_PROMPTS.english_teacher

  return [
    {
      role: 'system',
      content: [
        'You are pass 1 of a draft review engine. Return only valid JSON.',
        'Do not include markdown fences or extra commentary.',
        'You will be given a draft and persona, and must produce high-value line-level feedback.',
        '',
        'Output schema:',
        '{',
        '  "overall_feedback": string,',
        '  "suggestions": [',
        '    {',
        '      "id": string,',
        '      "start": number,',
        '      "end": number,',
        '      "source_text": string,',
        '      "replacement": string,',
        '      "comment": string,',
        '      "kind": "edit" | "comment",',
        '      "severity": "note" | "suggestion" | "important"',
        '    }',
        '  ]',
        '}',
        '',
        'Rules:',
        '- Indices are 0-based character offsets into the provided draft text.',
        '- Each suggestion must reference a contiguous span: [start,end).',
        '- source_text must be an exact copy of draft.slice(start,end).',
        '- Select whole words or whole phrases. Do not select partial words or mid-word fragments.',
        '- Keep suggestions non-overlapping and prioritize the highest impact fixes first.',
        '- For pure comments with no rewrite, replacement can be unchanged selected text or empty string.',
        '- Avoid rewriting the full draft. Target local improvements.',
        '- Never propose a no-op edit (replacement identical to source_text).',
        '- Never create edits that introduce duplicated text near the edit boundary.',
        '- If changing singular/plural or tense would require neighboring words to agree, include the full span needed for grammatical agreement.',
        '- Before finalizing, mentally apply each suggestion to the draft and remove any suggestion that causes grammar breakage, duplication, malformed words, or factual drift.',
        '- Persona adhesion is mandatory: feedback priorities, rewrite style, and comment framing must reflect the assigned persona.',
        '- Favor precision over quantity. If uncertain, omit the suggestion.',
        '- Keep each comment concise and specific (1-2 sentences).',
        `- Include up to ${suggestionCap} suggestions.`,
        '',
        'Persona:',
        persona.trim()
      ].join('\n')
    },
    {
      role: 'user',
      content: ['Draft:', text].join('\n')
    }
  ]
}

// Pass 2: quality/persona audit.
function buildAuditPrompt({ text, personaKey, suggestionCap, candidate }) {
  const persona = PERSONA_PROMPTS[personaKey] || PERSONA_PROMPTS.english_teacher
  const candidateJson = JSON.stringify(candidate || { overall_feedback: '', suggestions: [] })

  return [
    {
      role: 'system',
      content: [
        'You are pass 2, a strict editorial quality gate.',
        'Return only valid JSON and no extra prose.',
        'Your job is to audit candidate suggestions against the original draft and persona.',
        '',
        'Output schema:',
        '{',
        '  "overall_feedback": string,',
        '  "suggestions": [',
        '    {',
        '      "id": string,',
        '      "start": number,',
        '      "end": number,',
        '      "source_text": string,',
        '      "replacement": string,',
        '      "comment": string,',
        '      "kind": "edit" | "comment",',
        '      "severity": "note" | "suggestion" | "important"',
        '    }',
        '  ]',
        '}',
        '',
        'Audit rules:',
        '- Keep only suggestions that are accurate, beneficial, and persona-consistent.',
        '- Remove any suggestion with wrong span, partial-word span, overlap conflict, or no-op replacement.',
        '- Remove any suggestion that would degrade grammar, agreement, clarity, or rhythm.',
        '- Remove any suggestion that duplicates adjacent text, creates malformed words, or repeats existing text accidentally.',
        '- Explicitly reject partial-span replacements that would duplicate prefix/suffix text (example failure: selecting "o is worthy" then replacing with "Who is worthy").',
        '- Explicitly reject noun-number edits that break nearby agreement (example failure: changing "doors rumble" to "door rumble").',
        '- Enforce persona adhesion: remove or rewrite any suggestion whose rationale or edit style conflicts with persona priorities.',
        '- If needed, repair start/end/source_text/replacement so they align exactly to draft text and stay context-safe.',
        `- Return at most ${suggestionCap} suggestions.`,
        '',
        'Persona:',
        persona.trim()
      ].join('\n')
    },
    {
      role: 'user',
      content: ['Draft:', text, '', 'Candidate suggestions JSON:', candidateJson].join('\n')
    }
  ]
}

// Pass 3: span integrity and safe-apply verification.
function buildIntegrityPrompt({ text, suggestionCap, candidate }) {
  const candidateJson = JSON.stringify(candidate || { overall_feedback: '', suggestions: [] })

  return [
    {
      role: 'system',
      content: [
        'You are pass 3, a strict span-integrity and safe-apply verifier.',
        'Return only valid JSON and no extra prose.',
        'Your job is to remove or repair any suggestion that can corrupt text when applied.',
        '',
        'Output schema:',
        '{',
        '  "overall_feedback": string,',
        '  "suggestions": [',
        '    {',
        '      "id": string,',
        '      "start": number,',
        '      "end": number,',
        '      "source_text": string,',
        '      "replacement": string,',
        '      "comment": string,',
        '      "kind": "edit" | "comment",',
        '      "severity": "note" | "suggestion" | "important"',
        '    }',
        '  ]',
        '}',
        '',
        'Integrity rules:',
        '- Keep only suggestions that are safe to apply without text corruption.',
        '- source_text must equal draft.slice(start,end) exactly.',
        '- Reject suggestions that start/end inside a word and therefore clip text.',
        '- Reject suggestions that would create prefix/suffix duplication or malformed words when applied.',
        '- Reject suggestions with no meaningful change.',
        '- If uncertain, remove the suggestion rather than risk corruption.',
        `- Return at most ${suggestionCap} suggestions.`
      ].join('\n')
    },
    {
      role: 'user',
      content: ['Draft:', text, '', 'Candidate suggestions JSON:', candidateJson].join('\n')
    }
  ]
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

function buildCompletionRequestBody({ model, messages, maxTokens }) {
  const payload = {
    model,
    messages,
    response_format: { type: 'json_object' }
  }

  if (modelUsesMaxCompletionTokens(model)) {
    payload.max_completion_tokens = maxTokens
  } else {
    payload.max_tokens = maxTokens
    payload.temperature = 0.1
  }

  return payload
}

// Request/retry and timeout helpers.
function resolveMaxOutputTokens(textLength, model, attempt) {
  let base

  if (textLength > 15000) base = 1300
  else if (textLength > 10000) base = 1200
  else if (textLength > 5000) base = 1000
  else base = 800

  if (modelUsesMaxCompletionTokens(model)) {
    base += 400
  }

  return Math.min(base + attempt * 300, 2600)
}

function isRetryableStatus(status) {
  return [408, 429, 500, 502, 503, 504].includes(status)
}

function isLikelyModelFailure(status, raw) {
  if (status === 404) return true
  if (status !== 400) return false

  const message = extractUpstreamErrorMessage(raw).toLowerCase()
  return (
    message.includes('model') ||
    message.includes('does not exist') ||
    message.includes('unsupported') ||
    message.includes('not found')
  )
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function remainingBudgetMs(startedAt) {
  return FUNCTION_EXECUTION_BUDGET_MS - (Date.now() - startedAt)
}

// Single upstream request attempt.
async function callOpenAIOnce({ model, messages, maxTokens, timeoutMs }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildCompletionRequestBody({ model, messages, maxTokens })),
      signal: controller.signal
    })

    const raw = await res.text()

    if (!res.ok) {
      return { ok: false, status: res.status, raw, model }
    }

    return { ok: true, raw, model }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, status: 504, raw: 'OpenAI request timed out.', model }
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

// Multi-model retry orchestration with function time-budget awareness.
async function callOpenAI(messages, textLength, startedAt, preferredModels = []) {
  const defaultModels = [OPENAI_MODEL, ...OPENAI_MODEL_FALLBACKS]
  const selectedModels = preferredModels.length ? preferredModels : defaultModels
  const models = Array.from(new Set(selectedModels.filter(Boolean)))

  let lastFailure = {
    ok: false,
    status: 502,
    raw: 'No model configured.',
    model: OPENAI_MODEL
  }

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = remainingBudgetMs(startedAt)
      if (remaining < 4000) {
        return {
          ok: false,
          status: 504,
          raw: 'Function time budget exhausted before OpenAI completed.',
          model
        }
      }

      const timeoutMs = Math.max(3500, Math.min(OPENAI_TIMEOUT_MS + attempt * 5000, remaining - 800))
      const maxTokens = resolveMaxOutputTokens(textLength, model, attempt)
      const response = await callOpenAIOnce({ model, messages, maxTokens, timeoutMs })

      if (response.ok) {
        return response
      }

      lastFailure = response

      if (isRetryableStatus(response.status) && attempt < 1) {
        const pauseMs = Math.min((attempt + 1) * 500, Math.max(0, remainingBudgetMs(startedAt) - 3000))
        if (pauseMs > 0) {
          await delay(pauseMs)
        }
        continue
      }

      break
    }

    if (!isLikelyModelFailure(lastFailure.status, lastFailure.raw) && !isRetryableStatus(lastFailure.status)) {
      return lastFailure
    }
  }

  return lastFailure
}

// Parse assistant JSON from the chat.completions envelope.
function extractModelJson(rawEnvelope) {
  let envelope

  try {
    envelope = JSON.parse(rawEnvelope)
  } catch {
    return {
      ok: false,
      retryable: true,
      error: 'Failed to parse OpenAI response envelope.',
      details: String(rawEnvelope || '').slice(0, 500)
    }
  }

  const choice = envelope?.choices?.[0]
  const content = choice?.message?.content
  const finishReason = choice?.finish_reason

  if (typeof content !== 'string' || !content.trim()) {
    if (finishReason === 'length') {
      return {
        ok: false,
        retryable: true,
        error: 'Model output was truncated before JSON completed.',
        details: JSON.stringify({ finish_reason: finishReason, model: envelope?.model }).slice(0, 500)
      }
    }

    return {
      ok: false,
      retryable: true,
      error: 'Model returned empty content.',
      details: JSON.stringify({ finish_reason: finishReason, model: envelope?.model }).slice(0, 500)
    }
  }

  const trimmed = content.trim()

  try {
    return { ok: true, obj: JSON.parse(trimmed) }
  } catch {
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')

    if (firstBrace === -1 || lastBrace <= firstBrace) {
      if (finishReason === 'length') {
        return {
          ok: false,
          retryable: true,
          error: 'Model output was truncated before JSON completed.',
          details: trimmed.slice(0, 500)
        }
      }

      return {
        ok: false,
        retryable: true,
        error: 'Model did not return a JSON object.',
        details: trimmed.slice(0, 500)
      }
    }

    try {
      return { ok: true, obj: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) }
    } catch {
      return {
        ok: false,
        retryable: true,
        error: finishReason === 'length' ? 'Model output was truncated before JSON completed.' : 'Failed to parse JSON returned by model.',
        details: trimmed.slice(0, 500)
      }
    }
  }
}

// Suggestion normalization + hard safety filtering.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

function findBestSourceMatch(text, sourceText, hintStart, usedRanges) {
  if (!sourceText) return null

  let idx = text.indexOf(sourceText)
  if (idx === -1) return null

  let best = null
  let attempts = 0

  while (idx !== -1 && attempts < 300) {
    attempts += 1
    const start = idx
    const end = idx + sourceText.length

    const overlaps = usedRanges.some((range) => rangesOverlap(start, end, range.start, range.end))
    const distance = Math.abs(start - hintStart)

    if (!best || distance < best.distance || (distance === best.distance && !overlaps && best.overlaps)) {
      best = { start, end, distance, overlaps }
      if (distance === 0 && !overlaps) {
        break
      }
    }

    idx = text.indexOf(sourceText, idx + 1)
  }

  if (!best || best.overlaps) return null
  return { start: best.start, end: best.end }
}

function isWordChar(ch) {
  return typeof ch === 'string' && /[A-Za-z0-9]/.test(ch)
}

function hasMidWordBoundaries(text, start, end) {
  const startsMidWord = start > 0 && isWordChar(text[start - 1]) && isWordChar(text[start])
  const endsMidWord = end < text.length && isWordChar(text[end - 1]) && isWordChar(text[end])
  return startsMidWord || endsMidWord
}

function isNoOpEdit(selectedText, replacement) {
  return selectedText === replacement
}

function normalizeModelOutput(obj, text, suggestionCap) {
  const normalized = {
    overall_feedback: typeof obj?.overall_feedback === 'string' ? obj.overall_feedback : '',
    suggestions: []
  }

  const textLength = text.length
  const inputSuggestions = Array.isArray(obj?.suggestions) ? obj.suggestions : []
  const usedRanges = []

  for (let i = 0; i < inputSuggestions.length; i += 1) {
    if (normalized.suggestions.length >= suggestionCap) break

    const s = inputSuggestions[i]
    if (!s || typeof s !== 'object') continue

    let start = Number.isFinite(Number(s.start)) ? Math.floor(Number(s.start)) : -1
    let end = Number.isFinite(Number(s.end)) ? Math.floor(Number(s.end)) : -1

    start = Math.max(0, Math.min(textLength, start))
    end = Math.max(0, Math.min(textLength, end))

    let sourceText = typeof s.source_text === 'string' ? s.source_text : ''

    if (sourceText && sourceText.length <= 400) {
      const exactSlice = text.slice(start, end)
      if (exactSlice !== sourceText) {
        const anchored = findBestSourceMatch(text, sourceText, start, usedRanges)
        if (anchored) {
          start = anchored.start
          end = anchored.end
        }
      }
    }

    if (end <= start) continue

    const selectedText = text.slice(start, end)
    if (!selectedText) continue
    if (selectedText.length < 2) continue
    if (!/[A-Za-z0-9]/.test(selectedText)) continue

    if (sourceText && sourceText.length <= 400 && selectedText !== sourceText) {
      continue
    }

    if (hasMidWordBoundaries(text, start, end)) {
      continue
    }

    if (usedRanges.some((range) => rangesOverlap(start, end, range.start, range.end))) {
      continue
    }

    const kind = s.kind === 'comment' ? 'comment' : 'edit'
    const severity = ['note', 'suggestion', 'important'].includes(s.severity) ? s.severity : 'note'
    const replacement = typeof s.replacement === 'string' ? s.replacement : ''

    if (kind === 'edit') {
      if (isNoOpEdit(selectedText, replacement)) continue
    }

    sourceText = sourceText && sourceText.length <= 400 ? sourceText : selectedText

    normalized.suggestions.push({
      id: typeof s.id === 'string' && s.id.trim() ? s.id : `s-${i + 1}-${start}-${end}`,
      start,
      end,
      source_text: sourceText,
      replacement,
      comment: typeof s.comment === 'string' ? s.comment : '',
      kind,
      severity
    })

    usedRanges.push({ start, end })
  }

  normalized.suggestions.sort((a, b) => a.start - b.start)
  return normalized
}

// Chunking for long drafts to avoid function/model timeouts.
function shouldChunkReview(textLength) {
  return textLength >= REVIEW_CHUNK_TRIGGER_CHARS
}

function alignStartToWordBoundary(text, candidate, minStart) {
  const clampedMin = Math.max(0, Math.min(text.length, minStart))
  let start = Math.max(clampedMin, Math.min(text.length, candidate))

  if (start <= 0 || start >= text.length) return start
  if (!isWordChar(text[start - 1]) || !isWordChar(text[start])) return start

  const backLimit = Math.max(clampedMin, start - 80)
  for (let i = start - 1; i >= backLimit; i -= 1) {
    if (!isWordChar(text[i])) {
      return i + 1
    }
  }

  const forwardLimit = Math.min(text.length, start + 80)
  for (let i = start; i < forwardLimit; i += 1) {
    if (!isWordChar(text[i])) {
      return i + 1
    }
  }

  return start
}

function alignEndToWordBoundary(text, candidate, minEnd) {
  const clampedMin = Math.max(0, Math.min(text.length, minEnd))
  let end = Math.max(clampedMin, Math.min(text.length, candidate))

  if (end <= 0 || end >= text.length) return end
  if (!isWordChar(text[end - 1]) || !isWordChar(text[end])) return end

  const forwardLimit = Math.min(text.length, end + 80)
  for (let i = end; i < forwardLimit; i += 1) {
    if (!isWordChar(text[i])) {
      return i
    }
  }

  const backLimit = Math.max(clampedMin, end - 80)
  for (let i = end - 1; i >= backLimit; i -= 1) {
    if (!isWordChar(text[i])) {
      return i + 1
    }
  }

  return end
}

function annotateChunkOwnership(chunks) {
  if (!chunks.length) return chunks

  return chunks.map((chunk, index) => {
    const prev = chunks[index - 1]
    const next = chunks[index + 1]

    const rawAcceptStart = index === 0 ? chunk.start : Math.floor((prev.end + chunk.start) / 2)
    const rawAcceptEnd = index === chunks.length - 1 ? chunk.end : Math.floor((chunk.end + next.start) / 2)

    const acceptStart = Math.max(chunk.start, rawAcceptStart)
    const acceptEnd = Math.max(acceptStart + 1, Math.min(chunk.end, rawAcceptEnd))

    return {
      ...chunk,
      acceptStart,
      acceptEnd
    }
  })
}

function splitDraftIntoChunks(text) {
  const chunks = []
  let start = 0
  let guard = 0

  while (start < text.length && guard < REVIEW_MAX_CHUNKS) {
    guard += 1
    let end = Math.min(text.length, start + REVIEW_CHUNK_TARGET_CHARS)
    const minEnd = Math.min(text.length, start + Math.max(320, Math.floor(REVIEW_CHUNK_TARGET_CHARS * 0.5)))

    if (end < text.length) {
      const minBreak = start + Math.floor(REVIEW_CHUNK_TARGET_CHARS * 0.55)
      const paragraphBreak = text.lastIndexOf('\n\n', end)
      const lineBreak = text.lastIndexOf('\n', end)

      if (paragraphBreak > minBreak) {
        end = paragraphBreak + 2
      } else if (lineBreak > minBreak) {
        end = lineBreak + 1
      }
    }

    end = alignEndToWordBoundary(text, end, minEnd)

    if (end <= start) {
      end = Math.min(text.length, start + REVIEW_CHUNK_TARGET_CHARS)
    }

    chunks.push({
      start,
      end,
      text: text.slice(start, end)
    })

    if (end >= text.length) {
      break
    }

    const overlapStart = Math.max(end - REVIEW_CHUNK_OVERLAP_CHARS, start + 1)
    start = alignStartToWordBoundary(text, overlapStart, start + 1)
  }

  const coveredUntil = chunks.length ? chunks[chunks.length - 1].end : 0
  if (coveredUntil < text.length) {
    const previousStart = chunks.length ? chunks[chunks.length - 1].start + 1 : 0
    const rawTailStart = Math.max(0, text.length - REVIEW_CHUNK_TARGET_CHARS)
    const tailStart = alignStartToWordBoundary(text, rawTailStart, previousStart)
    chunks.push({
      start: tailStart,
      end: text.length,
      text: text.slice(tailStart)
    })
  }

  return annotateChunkOwnership(chunks)
}

// Merge helpers for chunked review outputs.
function compactOverallFeedback(feedbackItems) {
  const cleaned = feedbackItems
    .map((x) => String(x || '').trim())
    .filter(Boolean)

  if (!cleaned.length) return ''
  return cleaned.slice(0, 4).join('\n\n')
}

function mergeChunkSuggestions(text, chunkSuggestions) {
  const seen = new Set()
  const sorted = [...chunkSuggestions].sort((a, b) => a.start - b.start)
  const merged = []

  for (const s of sorted) {
    if (merged.length >= MAX_SUGGESTIONS) break
    if (!s || typeof s !== 'object') continue
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue
    if (s.end <= s.start) continue
    if (s.start < 0 || s.end > text.length) continue

    const key = `${s.start}:${s.end}`
    if (seen.has(key)) continue

    if (merged.some((m) => rangesOverlap(s.start, s.end, m.start, m.end))) continue

    const source = text.slice(s.start, s.end)
    if (!source || source.length < 2) continue

    merged.push({
      ...s,
      source_text: source
    })
    seen.add(key)
  }

  return merged
}

function makeOpenAIError(status, model, raw, prefix = 'OpenAI request failed.') {
  const upstreamMessage = extractUpstreamErrorMessage(raw)
  const message = upstreamMessage ? `${prefix} ${upstreamMessage}` : prefix
  return {
    ok: false,
    status,
    error: message,
    model,
    details: String(raw || '').slice(0, 500)
  }
}

// Pass runners.
async function requestStructuredReview({ text, personaKey, suggestionCap, startedAt, preferredModels = [] }) {
  const messages = buildDraftPrompt({ text, personaKey, suggestionCap })
  const upstream = await callOpenAI(messages, text.length, startedAt, preferredModels)

  if (!upstream.ok) {
    return makeOpenAIError(upstream.status, upstream.model, upstream.raw)
  }

  let extracted = extractModelJson(upstream.raw)
  let modelUsed = upstream.model
  let capUsed = suggestionCap

  if (!extracted.ok && extracted.retryable) {
    const fallbackCap = Math.min(suggestionCap, 10)
    const fallbackMessages = buildDraftPrompt({ text, personaKey, suggestionCap: fallbackCap })
    const recoveryModels = Array.from(new Set([...OPENAI_MODEL_FALLBACKS, 'gpt-4o-mini']))
      .filter((m) => m && m !== modelUsed)

    if (recoveryModels.length) {
      const recovery = await callOpenAI(fallbackMessages, text.length, startedAt, recoveryModels)

      if (!recovery.ok) {
        return makeOpenAIError(recovery.status, recovery.model, recovery.raw, 'OpenAI recovery request failed.')
      }

      const recoveredExtract = extractModelJson(recovery.raw)
      modelUsed = recovery.model

      if (recoveredExtract.ok) {
        extracted = recoveredExtract
        capUsed = fallbackCap
      } else {
        extracted = recoveredExtract
      }
    }
  }

  if (!extracted.ok) {
    return {
      ok: false,
      status: 502,
      error: extracted.error,
      model: modelUsed,
      details: extracted.details || String(upstream.raw || '').slice(0, 500)
    }
  }

  return {
    ok: true,
    model: modelUsed,
    normalized: normalizeModelOutput(extracted.obj, text, capUsed)
  }
}

async function auditStructuredReview({
  text,
  personaKey,
  suggestionCap,
  startedAt,
  candidate,
  preferredModels = []
}) {
  const remaining = remainingBudgetMs(startedAt)
  if (remaining < 7000) {
    return {
      ok: false,
      status: 504,
      error: 'Skipped quality-audit pass due to time budget.'
    }
  }

  const messages = buildAuditPrompt({ text, personaKey, suggestionCap, candidate })
  const upstream = await callOpenAI(messages, text.length, startedAt, preferredModels)

  if (!upstream.ok) {
    return makeOpenAIError(upstream.status, upstream.model, upstream.raw, 'Audit pass failed.')
  }

  const extracted = extractModelJson(upstream.raw)
  if (!extracted.ok) {
    return {
      ok: false,
      status: 502,
      error: extracted.error,
      model: upstream.model,
      details: extracted.details || String(upstream.raw || '').slice(0, 500)
    }
  }

  return {
    ok: true,
    model: upstream.model,
    normalized: normalizeModelOutput(extracted.obj, text, suggestionCap)
  }
}

async function integrityStructuredReview({ text, suggestionCap, startedAt, candidate, preferredModels = [] }) {
  const remaining = remainingBudgetMs(startedAt)
  if (remaining < 6000) {
    return {
      ok: false,
      status: 504,
      error: 'Skipped integrity pass due to time budget.'
    }
  }

  const messages = buildIntegrityPrompt({ text, suggestionCap, candidate })
  const upstream = await callOpenAI(messages, Math.min(text.length, 5000), startedAt, preferredModels)

  if (!upstream.ok) {
    return makeOpenAIError(upstream.status, upstream.model, upstream.raw, 'Integrity pass failed.')
  }

  const extracted = extractModelJson(upstream.raw)
  if (!extracted.ok) {
    return {
      ok: false,
      status: 502,
      error: extracted.error,
      model: upstream.model,
      details: extracted.details || String(upstream.raw || '').slice(0, 500)
    }
  }

  return {
    ok: true,
    model: upstream.model,
    normalized: normalizeModelOutput(extracted.obj, text, suggestionCap)
  }
}

// Main Netlify handler.
export async function handler(event) {
  try {
    const startedAt = Date.now()

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

    if (!text.trim()) {
      return jsonError(400, 'No text provided.')
    }

    if (rawText.length > MAX_CHARS) {
      return jsonError(400, `Text exceeds ${MAX_CHARS} characters.`)
    }

    if (shouldChunkReview(text.length)) {
      const chunks = splitDraftIntoChunks(text)
      const perChunkCap = Math.max(6, Math.ceil(MAX_SUGGESTIONS / Math.max(1, chunks.length)) + 1)

      const chunkResults = await Promise.all(
        chunks.map((chunk) =>
          requestStructuredReview({
            text: chunk.text,
            personaKey: persona,
            suggestionCap: perChunkCap,
            startedAt
          })
            .then((result) => ({ ...result, chunk }))
        )
      )

      const successes = chunkResults.filter((r) => r.ok)
      if (!successes.length) {
        const firstFailure = chunkResults.find((r) => !r.ok)
        const statusCode = firstFailure?.status === 504 ? 504 : 502
        return jsonError(statusCode, firstFailure?.error || 'OpenAI request failed.', {
          model: firstFailure?.model,
          details: firstFailure?.details
        })
      }

      const combinedSuggestions = []
      const combinedOverall = []

      for (const item of successes) {
        if (item.normalized?.overall_feedback) {
          combinedOverall.push(item.normalized.overall_feedback)
        }

        const shifted = (item.normalized?.suggestions || []).map((s) => ({
          ...s,
          start: s.start + item.chunk.start,
          end: s.end + item.chunk.start,
          id: `${item.chunk.start}-${s.id}`
        }))
          .filter((s) => s.start >= item.chunk.acceptStart && s.end <= item.chunk.acceptEnd)

        combinedSuggestions.push(...shifted)
      }

      const mergedSuggestions = mergeChunkSuggestions(text, combinedSuggestions)
      const candidate = {
        overall_feedback: compactOverallFeedback(combinedOverall),
        suggestions: mergedSuggestions
      }

      const audit = await auditStructuredReview({
        text,
        personaKey: persona,
        suggestionCap: MAX_SUGGESTIONS,
        startedAt,
        candidate,
        preferredModels: [OPENAI_MODEL, ...OPENAI_MODEL_FALLBACKS, 'gpt-4o-mini']
      })

      const auditedPayload = audit.ok
        ? {
            ...audit.normalized,
            overall_feedback: audit.normalized.overall_feedback || candidate.overall_feedback
          }
        : candidate

      const integrity = await integrityStructuredReview({
        text,
        suggestionCap: MAX_SUGGESTIONS,
        startedAt,
        candidate: auditedPayload,
        preferredModels: [audit?.model || OPENAI_MODEL, ...OPENAI_MODEL_FALLBACKS, 'gpt-4o-mini']
      })

      const finalPayload = integrity.ok
        ? {
            ...integrity.normalized,
            overall_feedback: integrity.normalized.overall_feedback || auditedPayload.overall_feedback
          }
        : auditedPayload

      return jsonResponse(200, finalPayload)
    }

    const suggestionCap = resolveSuggestionCap(text.length)
    const result = await requestStructuredReview({
      text,
      personaKey: persona,
      suggestionCap,
      startedAt
    })

    if (!result.ok) {
      const statusCode = result.status === 504 ? 504 : 502
      return jsonError(statusCode, result.error, {
        model: result.model,
        details: result.details
      })
    }

    const audit = await auditStructuredReview({
      text,
      personaKey: persona,
      suggestionCap,
      startedAt,
      candidate: result.normalized,
      preferredModels: [result.model, ...OPENAI_MODEL_FALLBACKS, 'gpt-4o-mini']
    })

    const auditedPayload = audit.ok
      ? {
          ...audit.normalized,
          overall_feedback: audit.normalized.overall_feedback || result.normalized.overall_feedback
        }
      : result.normalized

    const integrity = await integrityStructuredReview({
      text,
      suggestionCap,
      startedAt,
      candidate: auditedPayload,
      preferredModels: [audit?.model || result.model, ...OPENAI_MODEL_FALLBACKS, 'gpt-4o-mini']
    })

    if (integrity.ok) {
      return jsonResponse(200, {
        ...integrity.normalized,
        overall_feedback: integrity.normalized.overall_feedback || auditedPayload.overall_feedback
      })
    }

    return jsonResponse(200, auditedPayload)
  } catch (error) {
    return jsonError(500, 'Unexpected server error.', {
      details: typeof error?.message === 'string' ? error.message : 'Unknown error'
    })
  }
}
