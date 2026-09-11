/**
 * Mirror of the "Parse Menu Extraction" Code node in the n8n workflow
 * "HH Finder — Menu Photo OCR (sub-workflow)".
 *
 * Code nodes live inside the n8n workflow definition, where they cannot be unit
 * tested. This file mirrors that node's source so its behavioural contract is
 * reviewable and regression-tested here rather than only by hand in n8n. If you
 * edit the node, update this copy and re-run. See n8n-workflows/README.md.
 *
 * What it exists to pin down: a photo is supplied by whoever pointed the
 * camera, so nothing read off one may reach the feed unreviewed. The
 * confidence cap below 0.80 is what guarantees that — `hh_intake_deal`
 * auto-publishes at 0.80 and above — and it is the single line separating
 * "assisted submission" from "anyone with a camera writes to the feed".
 */

/** @param {unknown} response The Gemini node output. @param {{image_url: string}} ctx */
function parseMenuExtraction(response, ctx) {
  const $json = response ?? {};

  // The Gemini image node's response shape is not worth depending on: the model
  // was asked for JSON, so instead of reaching for a fixed path, walk the whole
  // response, collect every string, and take the first that parses as a JSON
  // object.
  const strings = [];
  const walk = (v, depth) => {
    if (depth > 8 || strings.length > 80) return;
    if (typeof v === 'string') {
      strings.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk($json, 0);

  const asObject = (s) => {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(s.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      // Kept as `catch (e)` to match the deployed node character for character:
      // the n8n Code sandbox is the source of truth and this file mirrors it.
      // eslint-disable-next-line no-unused-vars
    } catch (e) {
      return null;
    }
  };

  let ai = null;
  for (const s of strings) {
    ai = asObject(s);
    if (ai) break;
  }

  const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

  // Identical to canonicalTimeWindow in WF1's Normalize & Validate. The Code
  // sandbox has no shared modules, so the two copies must be kept in step.
  const canonicalTimeWindow = (input) => {
    if (!input) return null;
    const s = String(input)
      .trim()
      .replace(/[‐-―−]/g, '-')
      .replace(/\bto\b/gi, '-')
      .replace(/\s+/g, ' ');
    const parts = s.split('-').map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) return null;

    const parseSide = (side) => {
      let m = side.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
      if (m) {
        const h = parseInt(m[1], 10);
        if (h < 1 || h > 12) return null;
        const mins = m[2] ? parseInt(m[2], 10) : 0;
        if (mins > 59) return null;
        const mer = m[3].toUpperCase() + 'M';
        return m[2] ? h + ':' + m[2] + ' ' + mer : h + ' ' + mer;
      }
      m = side.match(/^(\d{1,2}):(\d{2})$/);
      if (m) {
        let h = parseInt(m[1], 10);
        const mins = parseInt(m[2], 10);
        if (h > 23 || mins > 59) return null;
        const mer = h >= 12 ? 'PM' : 'AM';
        h = h % 12;
        if (h === 0) h = 12;
        return mins === 0 ? h + ' ' + mer : h + ':' + m[2] + ' ' + mer;
      }
      return null;
    };

    const start = parseSide(parts[0]);
    const end = parseSide(parts[1]);
    return start && end ? start + ' - ' + end : null;
  };

  if (!ai) {
    const why =
      typeof $json.error === 'string'
        ? $json.error
        : $json.error && $json.error.message
          ? $json.error.message
          : 'the model returned nothing that parses as JSON';
    return {
      readable: false,
      usable: false,
      reason: String(why).slice(0, 200),
      image_url: ctx.image_url,
      extracted: null,
    };
  }

  const PHOTO_CONFIDENCE_CAP = 0.75;

  // One entry per set of hours on the board. A board that reads "Mon-Thu 4-6,
  // Fri 12-3" is two deals, and the submit form seeds a schedule row from each
  // -- which is how the app has always stored a happy hour whose hours change
  // with the day. `deals` is what the prompt asks for; a flat single-deal reply
  // is still read, so the node and the prompt can be rolled back independently.
  const entries = Array.isArray(ai.deals) && ai.deals.length ? ai.deals : [ai];

  const readOne = (entry) => {
    const rawWindow = str(entry.time_window);
    const timeWindow = canonicalTimeWindow(rawWindow);

    const days = Array.isArray(entry.days_active)
      ? entry.days_active
        .map((d) => parseInt(d, 10))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];

    let priceLevel = parseInt(entry.price_level ?? ai.price_level, 10);
    if (!Number.isInteger(priceLevel) || priceLevel < 1 || priceLevel > 4) priceLevel = 2;

    let confidence = Number(entry.confidence ?? ai.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(Math.max(confidence, 0), 1);
    // The single line separating "assisted submission" from "anyone with a
    // camera writes to the feed": intake auto-publishes at 0.80 and above.
    confidence = Math.min(confidence, PHOTO_CONFIDENCE_CAP);

    return {
      title: str(entry.title),
      description: str(entry.description),
      time_window: timeWindow,
      time_window_raw: rawWindow,
      days_active: days,
      tags: Array.isArray(entry.tags ?? ai.tags)
        ? (entry.tags ?? ai.tags).map((t) => String(t).trim()).filter(Boolean).slice(0, 10)
        : [],
      price_level: priceLevel,
      // The venue is a property of the photo, not of any one window on it.
      venue_name: str(entry.venue_name ?? ai.venue_name),
      confidence,
    };
  };

  const all = entries.map(readOne);
  // An entry is only worth seeding a form row from when it names a deal AND
  // gives hours the app can render. A half-read second window is dropped rather
  // than handed to the user as a blank schedule to puzzle over.
  const complete = all.filter((d) => !!d.title && !!d.time_window);

  const usable = ai.has_happy_hour === true && ai.legible !== false && complete.length > 0;

  const reason = usable
    ? null
    : ai.legible === false
      ? 'the photo is too blurred, dark or cropped to read'
      : ai.has_happy_hour !== true
        ? 'the photo does not advertise a happy hour or special'
        : !all.some((d) => d.title)
          ? 'no deal could be named from the photo'
          : 'no usable time window in the photo';

  return {
    readable: true,
    usable,
    reason,
    image_url: ctx.image_url,
    // Every set of hours the board listed. Empty unless the photo was usable.
    extractedAll: usable ? complete : [],
    // The first of them, kept because it is what the shipped app binaries read.
    //
    // `complete[0]`, not `all[0]`: when the model's FIRST entry is the one whose
    // window could not be read, those two are different deals, and an app that
    // reads only this field would show a title with a blank window while the
    // reply carried a perfectly good second window it never looked at. The
    // invariant is that whenever `usable` is true, this equals extractedAll[0].
    // `all[0]` remains the fallback so an unusable reply still has something for
    // the reason messaging to describe.
    extracted: complete[0] ?? all[0],
  };
}

const CTX = { image_url: 'https://example.supabase.co/storage/v1/object/public/venue-images/uid/menu.jpg' };

const GOOD = {
  has_happy_hour: true,
  title: '$4 Drafts & Half-Price Apps',
  time_window: '4 PM - 6 PM',
  days_active: [1, 2, 3, 4, 5],
  description: 'Discounted drafts at the bar',
  tags: ['beer'],
  price_level: 2,
  venue_name: '',
  legible: true,
  confidence: 0.7,
};

/** Wrap a model answer the way the Gemini node nests it. */
const asGeminiReply = (obj) => ({
  content: { parts: [{ text: JSON.stringify(obj) }], role: 'model' },
});

const withReply = (overrides) => parseMenuExtraction(asGeminiReply({ ...GOOD, ...overrides }), CTX);

describe('parseMenuExtraction', () => {
  describe('a board listing more than one set of hours', () => {
    const twoWindows = {
      has_happy_hour: true,
      legible: true,
      venue_name: "Parson's Chicken & Fish",
      price_level: 2,
      tags: ['beer'],
      confidence: 0.7,
      deals: [
        { title: '$4 Drafts', time_window: '4pm - 6:30pm', days_active: [1, 2, 3, 4] },
        { title: '$6 Negronis', time_window: '12pm - 3pm', days_active: [5] },
      ],
    };

    it('reads every window, not just the first', () => {
      const out = parseMenuExtraction({ text: JSON.stringify(twoWindows) }, CTX);
      expect(out.usable).toBe(true);
      expect(out.extractedAll).toHaveLength(2);
      expect(out.extractedAll[0].time_window).toBe('4 PM - 6:30 PM');
      expect(out.extractedAll[1].time_window).toBe('12 PM - 3 PM');
      expect(out.extractedAll[1].days_active).toEqual([5]);
    });

    it('caps every window below the auto-publish gate, not just the first', () => {
      const greedy = {
        ...twoWindows,
        deals: twoWindows.deals.map((d) => ({ ...d, confidence: 1 })),
      };
      const out = parseMenuExtraction({ text: JSON.stringify(greedy) }, CTX);
      // A photo is supplied by whoever pointed the camera. Nothing read off one
      // may reach the feed unreviewed, and that holds for the second window as
      // firmly as the first.
      expect(out.extractedAll.every((d) => d.confidence <= 0.75)).toBe(true);
    });

    it('carries the venue and tags down from the photo to every window', () => {
      const out = parseMenuExtraction({ text: JSON.stringify(twoWindows) }, CTX);
      expect(out.extractedAll.map((d) => d.venue_name)).toEqual([
        "Parson's Chicken & Fish",
        "Parson's Chicken & Fish",
      ]);
      expect(out.extractedAll[1].tags).toEqual(['beer']);
    });

    it('drops a window it could only half read rather than handing over a blank row', () => {
      const half = {
        ...twoWindows,
        deals: [twoWindows.deals[0], { title: '$6 Negronis', time_window: 'all day' }],
      };
      const out = parseMenuExtraction({ text: JSON.stringify(half) }, CTX);
      expect(out.usable).toBe(true);
      expect(out.extractedAll).toHaveLength(1);
      expect(out.extractedAll[0].title).toBe('$4 Drafts');
    });

    it('keeps the singular field on the first window it could actually read', () => {
      // Found by running the deployed node, not by this suite: the earlier
      // fixtures all had a readable first window, so `all[0]` and `complete[0]`
      // never diverged. Give the model a first entry whose hours cannot be
      // canonicalized and they do -- and an app reading only `deal` gets a
      // blank window while `deals` carries a good one.
      const firstUnreadable = {
        ...twoWindows,
        deals: [
          { title: '$4 Drafts', time_window: '4-6:30pm', days_active: [1, 2, 3, 4] },
          twoWindows.deals[1],
        ],
      };
      const out = parseMenuExtraction({ text: JSON.stringify(firstUnreadable) }, CTX);
      expect(out.usable).toBe(true);
      expect(out.extractedAll).toHaveLength(1);
      expect(out.extracted).toEqual(out.extractedAll[0]);
      expect(out.extracted.time_window).toBe('12 PM - 3 PM');
    });

    it('still describes an unusable reply through the singular field', () => {
      const noneReadable = {
        ...twoWindows,
        deals: [{ title: '$4 Drafts', time_window: 'all day', days_active: [1] }],
      };
      const out = parseMenuExtraction({ text: JSON.stringify(noneReadable) }, CTX);
      expect(out.usable).toBe(false);
      expect(out.extractedAll).toEqual([]);
      expect(out.extracted.title).toBe('$4 Drafts');
      expect(out.reason).toBe('no usable time window in the photo');
    });

    it('keeps the singular field pointing at the first window', () => {
      // The shipped app binaries read `deal`, which the endpoint fills from
      // this. It must not start meaning something else.
      const out = parseMenuExtraction({ text: JSON.stringify(twoWindows) }, CTX);
      expect(out.extracted.title).toBe('$4 Drafts');
    });
  });

  describe('finding the JSON', () => {
    it('reads the model answer out of the nested Gemini shape', () => {
      expect(withReply({}).extracted.title).toBe('$4 Drafts & Half-Price Apps');
    });

    it('tolerates a markdown fence around the JSON', () => {
      const fenced = { content: { parts: [{ text: '```json\n' + JSON.stringify(GOOD) + '\n```' }] } };
      expect(parseMenuExtraction(fenced, CTX).usable).toBe(true);
    });

    it('tolerates prose either side of the object', () => {
      const chatty = { text: 'Sure! Here is the deal:\n' + JSON.stringify(GOOD) + '\nHope that helps.' };
      expect(parseMenuExtraction(chatty, CTX).extracted.title).toBe(GOOD.title);
    });

    it('reports a model failure as a value rather than throwing', () => {
      const result = parseMenuExtraction({ error: { message: '429 quota exceeded' } }, CTX);
      expect(result).toMatchObject({ readable: false, usable: false, extracted: null });
      expect(result.reason).toBe('429 quota exceeded');
    });

    it('reports an unparseable reply rather than throwing', () => {
      const result = parseMenuExtraction({ content: { parts: [{ text: 'I cannot read this image.' }] } }, CTX);
      expect(result.readable).toBe(false);
      expect(result.extracted).toBeNull();
    });

    it('carries the image url through every path, so the caller can always show the photo', () => {
      expect(parseMenuExtraction({ error: 'boom' }, CTX).image_url).toBe(CTX.image_url);
      expect(withReply({}).image_url).toBe(CTX.image_url);
    });
  });

  /**
   * This is the load-bearing test of the whole photo path. `hh_intake_deal`
   * publishes at confidence >= 0.80; capping here at 0.75 is what keeps a
   * photo-derived deal in the review queue no matter what the model claims.
   */
  describe('the confidence cap', () => {
    it('caps a confident reading below the 0.80 auto-publish gate', () => {
      expect(withReply({ confidence: 0.99 }).extracted.confidence).toBe(0.75);
      expect(withReply({ confidence: 1 }).extracted.confidence).toBe(0.75);
      expect(withReply({ confidence: 7 }).extracted.confidence).toBe(0.75);
    });

    it('leaves a low reading alone', () => {
      expect(withReply({ confidence: 0.3 }).extracted.confidence).toBe(0.3);
    });

    it('treats a missing or nonsense confidence as zero', () => {
      expect(withReply({ confidence: undefined }).extracted.confidence).toBe(0);
      expect(withReply({ confidence: 'very' }).extracted.confidence).toBe(0);
      expect(withReply({ confidence: -3 }).extracted.confidence).toBe(0);
    });
  });

  describe('the time window', () => {
    it('canonicalizes the shapes a sign is actually written in', () => {
      expect(withReply({ time_window: '4pm to 6:30pm' }).extracted.time_window).toBe('4 PM - 6:30 PM');
      expect(withReply({ time_window: '16:00-19:00' }).extracted.time_window).toBe('4 PM - 7 PM');
      expect(withReply({ time_window: '4 P.M. – 6 P.M.' }).extracted.time_window).toBe('4 PM - 6 PM');
    });

    it('keeps the raw reading alongside the canonical one', () => {
      expect(withReply({ time_window: '4pm to 6:30pm' }).extracted.time_window_raw).toBe('4pm to 6:30pm');
    });

    it('is unusable when the hours cannot be expressed as a window', () => {
      const result = withReply({ time_window: 'until close' });
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('no usable time window in the photo');
      expect(result.extracted.time_window).toBeNull();
    });
  });

  describe('deciding a reading is usable', () => {
    it('is usable when the photo names a deal and its hours', () => {
      expect(withReply({}).usable).toBe(true);
      expect(withReply({}).reason).toBeNull();
    });

    it('is not usable when the photo advertises no happy hour', () => {
      const result = withReply({ has_happy_hour: false });
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('the photo does not advertise a happy hour or special');
    });

    it('is not usable when the model says the photo is illegible', () => {
      const result = withReply({ legible: false });
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('the photo is too blurred, dark or cropped to read');
    });

    it('is not usable without a title', () => {
      expect(withReply({ title: '   ' }).usable).toBe(false);
      expect(withReply({ title: '   ' }).reason).toBe('no deal could be named from the photo');
    });
  });

  describe('clamping the rest', () => {
    it('drops day numbers outside 0..6 and non-numbers', () => {
      expect(withReply({ days_active: [1, 9, -2, 'x', 6] }).extracted.days_active).toEqual([1, 6]);
      expect(withReply({ days_active: 'weekdays' }).extracted.days_active).toEqual([]);
    });

    it('falls back to price level 2 when the reading is out of range', () => {
      expect(withReply({ price_level: 9 }).extracted.price_level).toBe(2);
      expect(withReply({ price_level: 'cheap' }).extracted.price_level).toBe(2);
      expect(withReply({ price_level: 3 }).extracted.price_level).toBe(3);
    });

    it('bounds the tag list and drops blanks', () => {
      const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      expect(withReply({ tags: many }).extracted.tags).toHaveLength(10);
      expect(withReply({ tags: ['  beer  ', '', 'patio'] }).extracted.tags).toEqual(['beer', 'patio']);
      expect(withReply({ tags: 'beer' }).extracted.tags).toEqual([]);
    });

    it('returns a venue name only when the photo showed one', () => {
      expect(withReply({ venue_name: '' }).extracted.venue_name).toBeNull();
      expect(withReply({ venue_name: 'The Mixing Room' }).extracted.venue_name).toBe('The Mixing Room');
    });
  });
});
