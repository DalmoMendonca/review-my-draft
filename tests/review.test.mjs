import test from 'node:test'
import assert from 'node:assert/strict'

// We snapshot/restore env in each test so file-level env changes never leak
// into later tests.
const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_MODEL_FALLBACKS',
  'OPENAI_TIMEOUT_MS',
  'FUNCTION_EXECUTION_BUDGET_MS',
  'REVIEW_CHUNK_TRIGGER_CHARS',
  'REVIEW_CHUNK_TARGET_CHARS',
  'REVIEW_CHUNK_OVERLAP_CHARS',
  'REVIEW_MAX_CHUNKS'
]

function snapshotEnv() {
  const previous = {}
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key]
  }
  return () => {
    for (const key of ENV_KEYS) {
      if (typeof previous[key] === 'undefined') delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function freshQuery() {
  return `?test=${Date.now()}-${Math.random()}`
}

async function loadHandlerFresh() {
  const mod = await import(`../netlify/functions/review.js${freshQuery()}`)
  return mod.handler
}

async function loadWorkshopHandlerFresh() {
  const mod = await import(`../netlify/functions/workshop.js${freshQuery()}`)
  return mod.handler
}

function fakeResponse({ ok = true, status = 200, body = '{}' }) {
  return {
    ok,
    status,
    text: async () => body
  }
}

function successEnvelope(obj, model = 'mock-model') {
  return JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify(obj),
          refusal: null,
          annotations: []
        },
        finish_reason: 'stop'
      }
    ]
  })
}

function truncatedEnvelope(model = 'mock-model') {
  return JSON.stringify({
    id: 'chatcmpl-truncated',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          refusal: null,
          annotations: []
        },
        finish_reason: 'length'
      }
    ]
  })
}

// --- Review function tests ---
test('uses max_completion_tokens for gpt-5 models', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'
    process.env.OPENAI_TIMEOUT_MS = '5000'

    const seenBodies = []

    global.fetch = async (_url, options) => {
      seenBodies.push(JSON.parse(options.body))
      return fakeResponse({
        ok: true,
        status: 200,
        body: successEnvelope({ overall_feedback: 'ok', suggestions: [] }, 'gpt-5.2')
      })
    }

    const handler = await loadHandlerFresh()
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ text: 'Short draft.', persona: 'english_teacher' })
    })

    assert.equal(response.statusCode, 200)
    assert.ok(seenBodies.length >= 2)
    for (const body of seenBodies) {
      assert.ok('max_completion_tokens' in body)
      assert.ok(!('max_tokens' in body))
    }
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('falls back to secondary model when first model truncates with empty content', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'
    process.env.OPENAI_TIMEOUT_MS = '5000'
    process.env.FUNCTION_EXECUTION_BUDGET_MS = '28000'

    const calledModels = []
    let callCount = 0

    global.fetch = async (_url, options) => {
      callCount += 1
      const body = JSON.parse(options.body)
      calledModels.push(body.model)

      if (callCount === 1) {
        return fakeResponse({ ok: true, status: 200, body: truncatedEnvelope('gpt-5.2') })
      }

      return fakeResponse({
        ok: true,
        status: 200,
        body: successEnvelope(
          {
            overall_feedback: 'Recovered on fallback model.',
            suggestions: [
              {
                id: 's1',
                start: 0,
                end: 5,
                source_text: 'Draft',
                replacement: 'Draft',
                comment: 'Looks good.',
                kind: 'comment',
                severity: 'note'
              }
            ]
          },
          'gpt-4o-mini'
        )
      })
    }

    const handler = await loadHandlerFresh()
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ text: 'Draft text for fallback behavior.', persona: 'english_teacher' })
    })

    assert.equal(response.statusCode, 200)
    assert.equal(calledModels[0], 'gpt-5.2')
    assert.ok(calledModels.includes('gpt-4o-mini'))

    const payload = JSON.parse(response.body)
    assert.equal(payload.overall_feedback, 'Recovered on fallback model.')
    assert.equal(payload.suggestions.length, 1)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('returns 504 quickly when execution budget is too small', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'
    process.env.FUNCTION_EXECUTION_BUDGET_MS = '500'

    let fetchCalled = false
    global.fetch = async () => {
      fetchCalled = true
      return fakeResponse({ ok: true, status: 200, body: successEnvelope({ overall_feedback: '', suggestions: [] }) })
    }

    const handler = await loadHandlerFresh()
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ text: 'Budget test draft.', persona: 'english_teacher' })
    })

    assert.equal(response.statusCode, 504)
    assert.equal(fetchCalled, false)
    const payload = JSON.parse(response.body)
    assert.match(payload.error, /OpenAI request failed/)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('splits long drafts into multiple chunked review calls', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'
    process.env.FUNCTION_EXECUTION_BUDGET_MS = '28000'
    process.env.REVIEW_CHUNK_TRIGGER_CHARS = '2000'
    process.env.REVIEW_CHUNK_TARGET_CHARS = '1000'
    process.env.REVIEW_CHUNK_OVERLAP_CHARS = '50'
    process.env.REVIEW_MAX_CHUNKS = '4'

    let calls = 0
    global.fetch = async (_url, options) => {
      calls += 1
      const body = JSON.parse(options.body)
      const userContent = String(body.messages?.[1]?.content || '')
      const chunkText = userContent
        .replace(/^Draft:\n/, '')
        .split('\n\nCandidate suggestions JSON:')[0]
      const wordMatch = chunkText.match(/\b[A-Za-z]{4,}\b/)

      if (!wordMatch || !Number.isFinite(wordMatch.index)) {
        return fakeResponse({
          ok: true,
          status: 200,
          body: successEnvelope({ overall_feedback: `Chunk ${calls}`, suggestions: [] }, 'gpt-5.2')
        })
      }

      const start = wordMatch.index
      const end = start + wordMatch[0].length

      return fakeResponse({
        ok: true,
        status: 200,
        body: successEnvelope({
          overall_feedback: `Chunk ${calls}`,
          suggestions: [
            {
              id: `chunk-${calls}`,
              start,
              end,
              source_text: chunkText.slice(start, end),
              replacement: chunkText.slice(start, end),
              comment: 'Chunk-local note.',
              kind: 'comment',
              severity: 'note'
            }
          ]
        }, 'gpt-5.2')
      })
    }

    const handler = await loadHandlerFresh()
    const longText = Array.from({ length: 350 }, (_, i) => `Paragraph ${i} carries clear words and cadence.\n`).join('')
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ text: longText, persona: 'english_teacher' })
    })

    assert.equal(response.statusCode, 200)
    assert.ok(calls > 1)

    const payload = JSON.parse(response.body)
    assert.ok(Array.isArray(payload.suggestions))
    assert.ok(payload.suggestions.length >= 1)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('filters mid-word suggestions that would duplicate text on apply', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'
    process.env.OPENAI_TIMEOUT_MS = '5000'
    process.env.FUNCTION_EXECUTION_BUDGET_MS = '28000'

    let callCount = 0
    global.fetch = async () => {
      callCount += 1

      if (callCount === 1) {
        return fakeResponse({
          ok: true,
          status: 200,
          body: successEnvelope(
            {
              overall_feedback: 'Check opening.',
              suggestions: [
                {
                  id: 'dup-risk',
                  start: 2,
                  end: 13,
                  source_text: 'o is worthy',
                  replacement: 'Who is worthy',
                  comment: 'Capitalize opening.',
                  kind: 'edit',
                  severity: 'important'
                }
              ]
            },
            'gpt-5.2'
          )
        })
      }

      return fakeResponse({
        ok: true,
        status: 200,
        body: successEnvelope({ overall_feedback: 'Filtered unsafe edits.', suggestions: [] }, 'gpt-5.2')
      })
    }

    const handler = await loadHandlerFresh()
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ text: 'Who is worthy?', persona: 'english_teacher' })
    })

    assert.equal(response.statusCode, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.suggestions.length, 0)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('filters singularization edits that violate nearby agreement hints', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'
    process.env.OPENAI_TIMEOUT_MS = '5000'
    process.env.FUNCTION_EXECUTION_BUDGET_MS = '28000'

    const draft = 'Those doors rumble and each lock cracks.'
    const start = draft.indexOf('doors')
    const end = start + 'doors'.length

    let callCount = 0
    global.fetch = async () => {
      callCount += 1

      if (callCount === 1) {
        return fakeResponse({
          ok: true,
          status: 200,
          body: successEnvelope(
            {
              overall_feedback: 'Tighten noun choice.',
              suggestions: [
                {
                  id: 'agreement-risk',
                  start,
                  end,
                  source_text: 'doors',
                  replacement: 'door',
                  comment: 'Use singular for emphasis.',
                  kind: 'edit',
                  severity: 'suggestion'
                }
              ]
            },
            'gpt-5.2'
          )
        })
      }

      return fakeResponse({
        ok: true,
        status: 200,
        body: successEnvelope({ overall_feedback: 'Rejected unsafe agreement change.', suggestions: [] }, 'gpt-5.2')
      })
    }

    const handler = await loadHandlerFresh()
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ text: draft, persona: 'english_teacher' })
    })

    assert.equal(response.statusCode, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.suggestions.length, 0)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('rejects clipped mid-word spans even if every pass returns them', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'
    process.env.OPENAI_TIMEOUT_MS = '5000'
    process.env.FUNCTION_EXECUTION_BUDGET_MS = '28000'

    let calls = 0
    global.fetch = async () => {
      calls += 1
      return fakeResponse({
        ok: true,
        status: 200,
        body: successEnvelope(
          {
            overall_feedback: 'Unsafe suggestion present.',
            suggestions: [
              {
                id: 'clipped-1',
                start: 48,
                end: 61,
                source_text: 'hen vanished.',
                replacement: 'Then it vanished.',
                comment: 'Restore full phrase.',
                kind: 'edit',
                severity: 'important'
              }
            ]
          },
          'gpt-5.2'
        )
      })
    }

    const handler = await loadHandlerFresh()
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        text: 'The line between real and fake faltered, then blurred, then vanished.',
        persona: 'english_teacher'
      })
    })

    assert.equal(response.statusCode, 200)
    assert.ok(calls >= 2)
    const payload = JSON.parse(response.body)
    assert.equal(payload.suggestions.length, 0)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('rejects payloads above 20000 chars before any upstream call', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'

    global.fetch = async () => {
      throw new Error('fetch should not be called for oversized payloads')
    }

    const handler = await loadHandlerFresh()
    const oversizedText = 'a'.repeat(20001)
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({ text: oversizedText, persona: 'english_teacher' })
    })

    assert.equal(response.statusCode, 400)
    const payload = JSON.parse(response.body)
    assert.match(payload.error, /20000/)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

// --- Workshop function tests ---
test('workshop includes full draft and focused context, then returns reply JSON', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-5.2'
    process.env.OPENAI_MODEL_FALLBACKS = 'gpt-4o-mini'

    const seenBodies = []

    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body)
      seenBodies.push(body)
      return fakeResponse({
        ok: true,
        status: 200,
        body: successEnvelope(
          {
            assistant_reply: 'Good pushback. Let us keep the urgency but smooth the cadence.',
            updated_suggestion: {
              replacement: 'Then it vanished.',
              comment: 'This keeps continuity and avoids clipped phrasing.'
            }
          },
          'gpt-5.2'
        )
      })
    }

    const handler = await loadWorkshopHandlerFresh()
    const draft = 'Line one.\nLine two with target phrase.\nLine three.'
    const start = draft.indexOf('target phrase')
    const end = start + 'target phrase'.length

    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        text: draft,
        persona: 'english_teacher',
        suggestion: {
          id: 's1',
          start,
          end,
          source_text: 'target phrase',
          replacement: 'target line',
          comment: 'Tighten diction.',
          kind: 'edit',
          severity: 'suggestion'
        },
        user_reply: 'I disagree with this. Can we keep the tone but reduce the change?',
        thread: [{ role: 'assistant', text: 'Initial recommendation.' }]
      })
    })

    assert.equal(response.statusCode, 200)
    assert.equal(seenBodies.length, 1)

    const userMessage = seenBodies[0].messages?.[1]?.content || ''
    assert.match(userMessage, /Draft \(full\):/)
    assert.match(userMessage, /Focused context/)
    assert.match(userMessage, /Original suggestion/)
    assert.match(userMessage, /User reply:/)

    const payload = JSON.parse(response.body)
    assert.match(payload.assistant_reply, /Good pushback/)
    assert.equal(payload.updated_suggestion.replacement, 'Then it vanished.')
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})

test('workshop rejects missing user reply', { concurrency: false }, async () => {
  const restoreEnv = snapshotEnv()
  const originalFetch = global.fetch

  try {
    process.env.OPENAI_API_KEY = 'test-key'

    global.fetch = async () => {
      throw new Error('fetch should not be called for invalid workshop payload')
    }

    const handler = await loadWorkshopHandlerFresh()
    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        text: 'Draft text.',
        persona: 'english_teacher',
        suggestion: {
          id: 's1',
          start: 0,
          end: 5,
          replacement: 'Draft',
          comment: 'Ok',
          kind: 'edit',
          severity: 'note'
        },
        user_reply: '   '
      })
    })

    assert.equal(response.statusCode, 400)
    const payload = JSON.parse(response.body)
    assert.match(payload.error, /workshop reply/i)
  } finally {
    global.fetch = originalFetch
    restoreEnv()
  }
})
