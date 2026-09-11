/**
 * Mirror of the "Parse Probe Reply" Code node in the n8n workflow
 * "HH Finder — Deep Probe (Tier 4 fallback)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: the node must never turn a model failure, an
 * unreadable reply, or a weak guess into a proposal. Tier 4 evidence can come
 * from a web search, so everything it emits goes to a human for approval — and
 * this is the gate that decides what is even worth showing them, and how much
 * the digest should be told to trust it.
 */

function parseProbeReply(rawIn, ctxIn) {
  const raw = rawIn ?? {};
  const ctx = ctxIn ?? {};
  const MIN_CONFIDENCE = 0.5;

  const fail = (why) => ({
    deal_id: ctx.deal_id,
    title: ctx.title,
    probed: true,
    proposed: null,
    evidence_url: null,
    evidence_kind: null,
    notes: 'deep probe: ' + String(why).slice(0, 180),
  });

  // A model failure is not a finding, and it must never read as "this venue has
  // no happy hour". Two nodes downstream depend on the `modelFailed` flag set
  // here: File Proposal files the audit row under `deep_probe_failed` (keeping a
  // call the API refused out of the daily budget), and Probe Result reports
  // `model_failed` rather than the RPC's `nothing_found`.
  if (raw.error !== undefined) {
    const why =
      typeof raw.error === 'string'
        ? raw.error
        : raw.error && raw.error.message
          ? raw.error.message
          : 'unknown model error';
    return { ...fail('model call failed: ' + why), modelFailed: true };
  }

  // The googleGemini node's output shape depends on `simplify` and on which
  // built-in tools fired. Assuming one shape is the bug that made the
  // Information Extractor look like it returned nothing, so accept them all.
  const texts = [];
  const collect = (v) => {
    if (typeof v === 'string') {
      texts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(collect);
      return;
    }
    if (v && typeof v === 'object') {
      if (typeof v.text === 'string') texts.push(v.text);
      if (v.parts) collect(v.parts);
      if (v.content) collect(v.content);
      if (v.message) collect(v.message);
    }
  };
  collect(raw.content);
  collect(raw.text);
  collect(raw.output);
  collect(raw.candidates);

  const blob = texts.join('\n').trim();
  if (!blob) return fail('model returned no text');

  const start = blob.indexOf('{');
  const end = blob.lastIndexOf('}');
  if (start < 0 || end <= start) return fail('no JSON object in model reply');

  // A grounded reply is not raw model output. When googleSearch fires, the API
  // rewrites the text to attach citation segments, and that pass can drop a
  // value outright — see the execution-895 fixture below. Fill in the one thing
  // that can be filled in without inventing anything: a key whose value is
  // simply absent between the delimiters. Deliberately NOT a general JSON
  // repair — a truncated reply still has no closing brace and is refused above,
  // and the scan tracks string state so a colon inside a description is never
  // touched. Arrays get the same treatment one level down: a dangling separator
  // is dropped and an elided element becomes null.
  const fillElidedValues = (str) => {
    let out = '';
    let inString = false;
    let escaped = false;
    const nextMeaningful = (from) => {
      let j = from;
      while (j < str.length && /\s/.test(str[j])) j++;
      return j < str.length ? str[j] : '';
    };
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (escaped) {
        out += c;
        escaped = false;
        continue;
      }
      if (inString) {
        out += c;
        if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        out += c;
        inString = true;
        continue;
      }
      if (c === ':') {
        out += c;
        const n = nextMeaningful(i + 1);
        if (n === ',' || n === '}' || n === ']') out += 'null';
        continue;
      }
      if (c === ',') {
        const n = nextMeaningful(i + 1);
        if (n === '}' || n === ']') continue;
        out += c;
        if (n === ',') out += 'null';
        continue;
      }
      out += c;
    }
    return out;
  };

  const candidate = blob.slice(start, end + 1);
  let ai;
  let repaired = false;
  try {
    ai = JSON.parse(candidate);
  } catch (_e) {
    try {
      ai = JSON.parse(fillElidedValues(candidate));
      repaired = true;
    } catch (_e2) {
      return fail('model reply was not valid JSON');
    }
  }

  if (ai.has_happy_hour !== true) return fail('no happy hour found for this venue');

  const window = typeof ai.time_window === 'string' ? ai.time_window.trim() : '';
  if (!window) return fail('happy hour found but hours were not stated in a usable form');

  const conf = Number(ai.confidence);
  const confidence = Number.isFinite(conf) ? Math.min(Math.max(conf, 0), 1) : 0;
  if (confidence < MIN_CONFIDENCE) {
    return fail('reading too weak to be worth reviewing (confidence ' + confidence + ')');
  }

  // We could not read this site ourselves — that is why Tier 4 ran — so unlike
  // the crawler we cannot check the cited URL against pages we fetched. What we
  // CAN check is whether the URL the model cites is even on the venue's own
  // domain, and that is what decides which label the reading carries.
  //
  // The digest is a strict binary: anything that is not exactly 'web_search' is
  // rendered as "the model read the venue's own site" with no staleness
  // warning. So an unverified kind has to fall to the CAUTIOUS side.
  const hostOf = (u) => {
    const m = String(u || '').match(/^https?:\/\/([^/?#]+)/i);
    if (!m) return null;
    return m[1]
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/:\d+$/, '');
  };
  const url =
    typeof ai.evidence_url === 'string' && /^https?:\/\//i.test(ai.evidence_url.trim())
      ? ai.evidence_url.trim()
      : null;

  const cited = hostOf(url);
  const own = hostOf(ctx.website);
  // Subdomains of the venue's own domain count, the way the crawler treats
  // www/non-www as the same host. Anything else does not.
  const onOwnSite =
    cited !== null &&
    own !== null &&
    (cited === own || cited.endsWith('.' + own) || own.endsWith('.' + cited));

  const kind = ai.evidence_kind === 'url_context' && onOwnSite ? 'url_context' : 'web_search';

  return {
    deal_id: ctx.deal_id,
    title: ctx.title,
    probed: true,
    proposed: {
      time_window: window,
      days_active: Array.isArray(ai.days_active) ? ai.days_active : [],
      description: typeof ai.description === 'string' ? ai.description.slice(0, 200) : null,
      confidence: confidence,
    },
    evidence_url: url,
    evidence_kind: kind,
    // The repair note travels with the proposal into the digest, so a reviewer
    // sees that a field was missing rather than silently absent.
    notes:
      'deep probe via ' +
      kind +
      (repaired ? ' (grounding dropped a field)' : '') +
      ': ' +
      String(ai.reasoning || 'hours read').slice(0, 160),
  };
}

const CTX = { deal_id: 'deal-1', title: 'Taco Bar HH', website: 'https://tacobar.example/' };

const GOOD = JSON.stringify({
  has_happy_hour: true,
  time_window: '4 PM - 6 PM',
  days_active: [1, 2, 3, 4],
  description: 'Tacos and margaritas',
  evidence_kind: 'url_context',
  evidence_url: 'https://tacobar.example/menu/happy-hour/',
  confidence: 0.85,
  reasoning: 'read from the happy hour page',
});

describe('deep probe: reading the model reply', () => {
  // The node must not care which of these the googleGemini node happens to emit.
  it.each([
    ['simplify:true nests under content.parts', { content: { parts: [{ text: GOOD }] } }],
    ['a flat text field', { text: GOOD }],
    ['the raw candidates array', { candidates: [{ content: { parts: [{ text: GOOD }] } }] }],
    ['nested under output', { output: GOOD }],
  ])('reads a proposal from %s', (_label, shape) => {
    const r = parseProbeReply(shape, CTX);
    expect(r.proposed.time_window).toBe('4 PM - 6 PM');
    expect(r.proposed.days_active).toEqual([1, 2, 3, 4]);
    expect(r.evidence_kind).toBe('url_context');
  });

  it('digs the object out of a fenced code block', () => {
    expect(parseProbeReply({ text: '```json\n' + GOOD + '\n```' }, CTX).proposed).toBeTruthy();
  });

  it('digs the object out from behind conversational preamble', () => {
    const r = parseProbeReply({ text: 'Here is what I found:\n' + GOOD + '\nHope that helps.' }, CTX);
    expect(r.proposed).toBeTruthy();
  });
});

describe('deep probe: what must never become a proposal', () => {
  it('a failed model call is flagged as a failure, not as "no happy hour"', () => {
    const r = parseProbeReply({ error: { message: 'quota exceeded' } }, CTX);
    expect(r.proposed).toBeNull();
    expect(r.modelFailed).toBe(true);
    expect(r.notes).toMatch(/quota exceeded/);
  });

  // The flag is not cosmetic: File Proposal reads it to keep a refused call out
  // of the daily budget, and Probe Result reads it to report `model_failed`.
  it.each([
    ['a 429 as a bare string', 'The service is receiving too many requests from you'],
    ['an error object', { message: 'ETIMEDOUT' }],
    ['an error with no message', {}],
  ])('sets modelFailed for %s', (_label, error) => {
    expect(parseProbeReply({ error }, CTX).modelFailed).toBe(true);
  });

  it('does not set modelFailed on a reply it simply could not read', () => {
    expect(parseProbeReply({ text: 'I could not find anything.' }, CTX).modelFailed).toBeUndefined();
  });

  it('a confident "no happy hour here" proposes nothing', () => {
    const reply = JSON.stringify({ has_happy_hour: false, confidence: 0.95 });
    expect(parseProbeReply({ text: reply }, CTX).proposed).toBeNull();
  });

  it('a happy hour with no usable window proposes nothing', () => {
    const reply = JSON.stringify({ has_happy_hour: true, time_window: '', confidence: 0.9 });
    expect(parseProbeReply({ text: reply }, CTX).proposed).toBeNull();
  });

  it('a weak reading is dropped before it reaches a human', () => {
    const reply = JSON.stringify({ has_happy_hour: true, time_window: '4 PM - 6 PM', confidence: 0.3 });
    const r = parseProbeReply({ text: reply }, CTX);
    expect(r.proposed).toBeNull();
    expect(r.notes).toMatch(/too weak/);
  });

  it('keeps a reading exactly at the 0.5 floor', () => {
    const reply = JSON.stringify({ has_happy_hour: true, time_window: '4 PM - 6 PM', confidence: 0.5 });
    expect(parseProbeReply({ text: reply }, CTX).proposed).toBeTruthy();
  });

  it.each([
    ['prose with no JSON', { text: 'I could not find anything.' }],
    ['truncated JSON', { text: '{ "has_happy_hour": true, ' }],
    ['an empty response', {}],
    ['nothing at all', null],
  ])('survives %s without throwing', (_label, shape) => {
    expect(parseProbeReply(shape, CTX).proposed).toBeNull();
  });
});

describe('deep probe: bounding what the model can put in the queue', () => {
  const withGood = (extra) =>
    parseProbeReply(
      { text: JSON.stringify({ has_happy_hour: true, time_window: '4 PM - 6 PM', confidence: 0.9, ...extra }) },
      CTX
    );

  it('drops an evidence_url that is not http(s)', () => {
    expect(withGood({ evidence_url: 'javascript:alert(1)' }).evidence_url).toBeNull();
  });

  it('keeps a real evidence_url', () => {
    expect(withGood({ evidence_url: 'https://example.com/hh' }).evidence_url).toBe('https://example.com/hh');
  });

  it('bounds the description to 200 characters', () => {
    expect(withGood({ description: 'x'.repeat(500) }).proposed.description).toHaveLength(200);
  });

  it('clamps confidence into 0..1', () => {
    expect(withGood({ confidence: 7 }).proposed.confidence).toBe(1);
    expect(parseProbeReply(
      { text: JSON.stringify({ has_happy_hour: true, time_window: '4 PM - 6 PM', confidence: 'banana' }) },
      CTX
    ).proposed).toBeNull();
  });

  it('tolerates days_active being absent or not an array', () => {
    expect(withGood({}).proposed.days_active).toEqual([]);
    expect(withGood({ days_active: 'weekdays' }).proposed.days_active).toEqual([]);
  });
});

/**
 * The digest renders `evidence_kind === 'web_search'` with a "check the date
 * before approving" warning and everything else as the venue's own claim about
 * itself. That is a strict binary, so an unverifiable claim has to land on the
 * cautious side of it.
 *
 * This used to default to `url_context` — the HIGH-trust label — which
 * laundered precisely the case Tier 4 exists to contain: an undated blog post
 * found by search, badged as if the venue had said it.
 */
describe('deep probe: an unverified reading is labelled web_search, not url_context', () => {
  const claim = (extra) =>
    parseProbeReply(
      {
        text: JSON.stringify({
          has_happy_hour: true,
          time_window: '4 PM - 6 PM',
          confidence: 0.9,
          ...extra,
        }),
      },
      CTX
    );

  it.each([
    ['no evidence_kind at all', {}],
    ['a misspelled kind', { evidence_kind: 'urlcontext' }],
    ['a kind nobody defined', { evidence_kind: 'vibes' }],
    ['an explicit web_search', { evidence_kind: 'web_search' }],
  ])('labels %s as web_search', (_label, extra) => {
    expect(claim({ evidence_url: 'https://tacobar.example/hh', ...extra }).evidence_kind).toBe('web_search');
  });

  // The regression this block was added for: url_context is a claim we can
  // partly check, so it is only honoured when the cited URL is on the venue's
  // own domain.
  it('honours url_context when the cited URL is the venue\'s own site', () => {
    const r = claim({ evidence_kind: 'url_context', evidence_url: 'https://tacobar.example/menu/happy-hour/' });
    expect(r.evidence_kind).toBe('url_context');
  });

  it.each([
    ['www vs bare', 'https://www.tacobar.example/happy-hour'],
    ['a subdomain', 'https://order.tacobar.example/hh'],
    ['a port', 'https://tacobar.example:443/hh'],
    ['an uppercase host', 'https://TacoBar.example/hh'],
  ])('treats %s as the venue\'s own site', (_label, evidenceUrl) => {
    const r = claim({ evidence_kind: 'url_context', evidence_url: evidenceUrl });
    expect(r.evidence_kind).toBe('url_context');
  });

  it.each([
    ['an aggregator', 'https://www.yelp.com/biz/taco-bar'],
    ['a blog', 'https://chicagofoodblog.example/2019/taco-bar'],
    ['a lookalike domain', 'https://tacobar.example.evil.example/hh'],
    ['no URL at all', undefined],
    ['an unusable URL', 'javascript:alert(1)'],
  ])('demotes a url_context claim citing %s', (_label, evidenceUrl) => {
    const r = claim({ evidence_kind: 'url_context', evidence_url: evidenceUrl });
    expect(r.evidence_kind).toBe('web_search');
  });

  it('demotes when the deal carries no website to compare against', () => {
    const r = parseProbeReply(
      {
        text: JSON.stringify({
          has_happy_hour: true,
          time_window: '4 PM - 6 PM',
          confidence: 0.9,
          evidence_kind: 'url_context',
          evidence_url: 'https://tacobar.example/hh',
        }),
      },
      { deal_id: 'deal-1', title: 'Taco Bar HH' }
    );
    expect(r.evidence_kind).toBe('web_search');
  });

  it('names the kind it settled on in the notes the digest shows', () => {
    expect(claim({ evidence_kind: 'vibes', evidence_url: 'https://example.com/x' }).notes).toMatch(
      /^deep probe via web_search:/
    );
  });
});

/**
 * A grounded reply is not raw model output: the API rewrites the text to attach
 * citation segments, and that pass can drop a value on its way out.
 *
 * The fixture below is the verbatim reply from a production run — `finishReason:
 * STOP`, 251 output tokens, so not a truncation. `"days_active":` has no value
 * at all, and the `groundingSupports` segments end at index 65 and resume at
 * index 65: exactly where the array should have been. A complete, usable
 * reading of a real venue's hours was being thrown away over a missing
 * `[1,2,3,4]`.
 */
describe('deep probe: a value the grounding pass dropped', () => {
  // Verbatim from a production run, evidence_url truncated for width only.
  const ELIDED =
    '{"has_happy_hour":true,"time_window":"4 PM - 7 PM","days_active":,' +
    '"description":"Happy Hour with various drink specials.",' +
    '"evidence_kind":"web_search",' +
    '"evidence_url":"https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHwM5g",' +
    '"confidence":0.9,' +
    '"reasoning":"Happy hour details for The Rabbit Hole in Old Town Chicago were found on HHRevolution."}';

  it('recovers the reading instead of discarding the whole reply', () => {
    const r = parseProbeReply({ content: { parts: [{ text: ELIDED }] } }, CTX);
    expect(r.proposed).toBeTruthy();
    expect(r.proposed.time_window).toBe('4 PM - 7 PM');
    expect(r.proposed.confidence).toBe(0.9);
  });

  it('degrades the dropped field to "not stated" rather than inventing one', () => {
    const r = parseProbeReply({ content: { parts: [{ text: ELIDED }] } }, CTX);
    // hh_valid_days_active rejects an empty array, so the RPC stores null and
    // hh_review_proposal's coalesce leaves the deal's existing days alone.
    expect(r.proposed.days_active).toEqual([]);
  });

  it('tells the reviewer the reply had to be repaired', () => {
    const r = parseProbeReply({ content: { parts: [{ text: ELIDED }] } }, CTX);
    expect(r.notes).toContain('grounding dropped a field');
  });

  it('still labels a grounded answer web_search — the redirect is not the venue', () => {
    const r = parseProbeReply({ content: { parts: [{ text: ELIDED }] } }, CTX);
    expect(r.evidence_kind).toBe('web_search');
  });

  it.each([
    ['a trailing key', '{"has_happy_hour":true,"time_window":"4 PM - 6 PM","confidence":0.9,"days_active":}'],
    ['an elided element', '{"has_happy_hour":true,"time_window":"4 PM - 6 PM","confidence":0.9,"days_active":[1,2,]}'],
    ['whitespace before the comma', '{"has_happy_hour":true,"time_window":"4 PM - 6 PM","confidence":0.9,"days_active":  ,"description":"x"}'],
  ])('handles %s', (_label, text) => {
    expect(parseProbeReply({ text }, CTX).proposed).toBeTruthy();
  });

  // The repair must not reach inside a string, or a description containing
  // ": ," would be corrupted into something that parses differently.
  it('never rewrites a colon inside a string value', () => {
    const text = JSON.stringify({
      has_happy_hour: true,
      time_window: '4 PM - 6 PM',
      confidence: 0.9,
      days_active: null,
      description: 'Hours: , see site',
      reasoning: 'Note: , unclear',
    }).replace('"days_active":null', '"days_active":');
    const r = parseProbeReply({ text }, CTX);
    expect(r.proposed.description).toBe('Hours: , see site');
    expect(r.notes).toContain('Note: , unclear');
  });

  it('leaves a well-formed reply completely alone', () => {
    const r = parseProbeReply({ text: GOOD }, CTX);
    expect(r.proposed.days_active).toEqual([1, 2, 3, 4]);
    expect(r.notes).not.toContain('grounding dropped a field');
  });

  // The repair fills absent values; it does not resurrect a reply that was cut
  // off, which stays a refusal.
  it.each([
    ['a truncated object', '{ "has_happy_hour": true, "time_window": "4 PM'],
    ['garbage between braces', '{ not json at all }'],
  ])('still refuses %s', (_label, text) => {
    const r = parseProbeReply({ text }, CTX);
    expect(r.proposed).toBeNull();
    expect(r.notes).toMatch(/not valid JSON|no JSON object/);
  });
});
