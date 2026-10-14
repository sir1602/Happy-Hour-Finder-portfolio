/* eslint-env browser */
// Animated map of the n8n workflows on the case study. Each run is a list of steps: a step lights
// its boxes, traces its lines in gold and sends a dot along each one. Selecting a box pauses the
// run and explains that workflow instead. Without JS the full map still shows, unanimated.
(function () {
  const fig = document.getElementById('workflow-motion');
  if (!fig) return;
  fig.classList.add('is-live');

  const NS = 'http://www.w3.org/2000/svg';
  const svg = fig.querySelector('svg');
  const traceLayer = svg.querySelector('.f-traces');
  const dotLayer = svg.querySelector('.f-dots');
  const canvas = fig.querySelector('.flow-canvas');
  const tabs = fig.querySelectorAll('.flow-tab');
  const stepEl = fig.querySelector('.flow-step');
  const textEl = fig.querySelector('.flow-text');
  const bar = fig.querySelector('.flow-progress span');
  const playBtn = fig.querySelector('[data-action="play"]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // What each box is, in the words of the workflow docs (n8n-workflows/README.md in the app repo).
  const NODES = {
    wf3: ['WF3 · Weekly Chicago Discovery', 'Scheduled for Sundays at 2 AM, and run by hand for now. It hands Chicago to the Area Scan Engine, 25 places a run.'],
    wf5: ['WF5 · Burst Area Scan', 'A form behind a login that I can open on my phone in a new city. It creates the metro if it is new, runs the Area Scan Engine there, and emails the result.'],
    sheet: ['Venue batch sheet', 'A weekly Claude Code routine lines up about 25 Chicago venues in a Google Sheet. The intake API looks each one up on Google Maps and sends only the rows I approve.'],
    app: ['The app', 'People submit deals or photograph a menu board. A photo goes to the intake API to be read. A submission is saved as a pending deal for review.'],
    wf2: ['WF2 · Daily Deal Re-Validation', 'At 4 AM it takes the 20 venues checked longest ago, crawls each once, and has Gemini check every deal stored for it. After two model failures in a row it stops calling the model for the night.'],
    wf6: ['WF6 · Venue Artwork Backfill', 'Finds a venue a picture of itself on its own website. The picture waits in a private bucket until it is approved in the review console.'],
    engine: ['Area Scan Engine', 'Apify sweeps Google Maps for an area, venues already on file are dropped, and each new one is crawled and read by one Gemini call, or taken from Google’s own listed happy hours. It never writes to the database itself.'],
    crawler: ['Site Crawler', 'Two rounds of plain HTTP: the known page, the homepage and the sitemap, then up to six pages scored by words like “happy hour”, “specials” and the neighborhood name. It returns evidence, never a verdict.'],
    probe: ['Deep Probe', 'For sites plain HTTP can’t read. Gemini fetches the page or searches the web and says which, and only a reading from the venue’s own site counts as high trust. At most 18 a day.'],
    wf1: ['WF1 · Deal Intake API', 'The one door for every automated source. It dedupes, geocodes and normalizes, and refuses a venue it can’t place rather than guess. One SQL function then decides live or pending.'],
    ocr: ['Menu Photo OCR', 'One photo in, deal fields out. Its confidence is capped below the publish bar, and a failure comes back as an answer the app can show, not a crash.'],
    active: ['Live in the app', 'Active deals, shown with countdowns that run on the venue’s own clock.'],
    db: ['Publish gate, in SQL', 'A deal goes live only at confidence of 0.80 or more with a time window the app’s own parser accepts. The guardrails live here too, so they hold whatever a model returns.'],
    queue: ['Review queue', 'Pending deals, proposed corrections and unreviewed venue photos, all waiting for a person.'],
    wf4: ['WF4 · Review Digest & Approvals', 'A Monday 8 AM email says what is waiting, and a review console behind a login shows the evidence. A link opens a confirm page; nothing changes until it is confirmed.'],
    alert: ['Failure Alert', 'Every workflow names it as its error handler. It pushes to my phone first and then emails, with the node that failed, the error and a link to the run.']
  };

  // A path is "from-to". `at` delays a leg (ms into the step); `back` sends the dot there and
  // back, for a call that returns its result.
  const FLOWS = {
    discover: { name: 'Find new venues', steps: [
      { nodes: ['wf3', 'wf5', 'engine'], paths: ['wf3-engine', { id: 'wf5-engine', at: 250 }],
        text: 'A weekly Chicago scan, or a form I can open on my phone in any city, hands an area to the Area Scan Engine. It sweeps Google Maps and drops venues already on file.' },
      { nodes: ['engine', 'crawler'], paths: [{ id: 'engine-crawler', back: true }],
        text: 'Each new venue’s own site is crawled over plain HTTP: the homepage, the sitemap and up to six pages scored by words like “happy hour” and “specials”. No model quota spent.' },
      { nodes: ['engine', 'sheet', 'wf1'], paths: ['engine-wf1', { id: 'sheet-wf1', at: 500 }],
        text: 'One Gemini call reads what the crawl found, unless Google already lists the venue’s happy hours. Every find goes to the intake API, the same door the weekly venue sheet uses.' },
      { nodes: ['wf1', 'db'], paths: ['wf1-db'],
        text: 'Intake dedupes, geocodes the address, and refuses a venue it can’t place rather than guess where it is.' },
      { nodes: ['db', 'active', 'queue'], paths: ['db-active', { id: 'db-queue', at: 250 }],
        text: 'One SQL function makes the call. Confidence of 0.80 or more and a time window the app can parse go live. Everything else waits for review.' }
    ] },
    recheck: { name: 'Nightly re-check', steps: [
      { nodes: ['wf2', 'crawler'], paths: [{ id: 'wf2-crawler', back: true }],
        text: 'At 4 AM the 20 venues checked longest ago are crawled again. One crawl per venue, however many deals it has.' },
      { nodes: ['wf2', 'db', 'queue'], paths: ['wf2-db', { id: 'db-queue', at: 1300 }],
        text: 'Gemini checks every stored deal against the page. A confident reading confirms it, corrects it, or sends it back for review; a weak one only flags a conflict.' },
      { nodes: ['wf2', 'probe'], paths: ['wf2-probe'],
        text: 'Sites plain HTTP can’t read go to the Deep Probe, where Gemini renders the page or searches for it. At most 18 probes a day.' },
      { nodes: ['probe', 'queue'], paths: ['probe-queue'],
        text: 'The probe can only file proposals for review. It has no write path to a live deal.' }
    ] },
    photo: { name: 'Menu photo', steps: [
      { nodes: ['app', 'wf1'], paths: ['app-wf1'],
        text: 'Someone photographs a menu board in the app. The photo goes to the intake API’s scan endpoint, which checks they’re signed in and meters Gemini use per person.' },
      { nodes: ['wf1', 'ocr'], paths: ['wf1-ocr'],
        text: 'Menu Photo OCR has Gemini read the board and turns the times into the app’s format.' },
      { nodes: ['ocr', 'app'], paths: ['ocr-app'],
        text: 'The fields go back into the person’s form, not the database. OCR misreads menus, so the person checks and fixes them first.' },
      { nodes: ['app', 'queue'], paths: ['app-queue'],
        text: 'On Submit the app saves a pending deal, so a person approves it before anyone sees it.' }
    ] },
    review: { name: 'Human review', steps: [
      { nodes: ['db', 'app', 'probe', 'queue'], paths: ['db-queue', { id: 'app-queue', at: 200 }, { id: 'probe-queue', at: 400 }],
        text: 'Three things feed the review queue: deals under the publish bar, app submissions, and corrections the probe proposes.' },
      { nodes: ['queue', 'wf4'], paths: ['queue-wf4'],
        text: 'Every Monday an email lists what is waiting, and a review console shows the evidence beside each item.' },
      { nodes: ['wf6', 'wf4'], paths: ['wf6-wf4'],
        text: 'Venue photos from the artwork backfill wait here too, private until someone approves them.' },
      { nodes: ['wf4', 'db', 'active'], paths: ['wf4-db', { id: 'db-active', at: 1300 }],
        text: 'Approving takes a click and then a confirm. Only then does the deal go live.' }
    ] },
    failure: { name: 'When it breaks', alert: true, steps: [
      { nodes: ['wf6', 'probe', 'wf4', 'alert'], paths: ['wf6-alert', { id: 'probe-alert', at: 200 }, { id: 'wf4-alert', at: 400 }],
        text: 'Every workflow names the Failure Alert as its error handler, so a crash, or a schedule that never fired, is reported instead of vanishing.' },
      { nodes: ['alert'], paths: [],
        text: 'It pushes to my phone first and emails second, so an expired email login can’t silence its own alarm.' }
    ] }
  };

  const ORDER = Object.keys(FLOWS);
  const TRAVEL_MS = 1150;
  const READ_MS = 5400;
  let flowKey = ORDER[0], step = 0, inspected = null;
  let playing = !reduced.matches, visible = false;
  let timer = null, raf = null, barAnim = null;

  const pathEl = (id) => svg.querySelector('#p-' + id);
  const nodeEl = (id) => svg.querySelector('#n-' + id);
  const spec = (p) => (typeof p === 'string' ? { id: p, at: 0 } : { at: 0, ...p });
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  function stepMs(s) {
    let end = 0;
    s.paths.forEach((p) => { const q = spec(p); end = Math.max(end, q.at + (q.back ? 2 : 1) * TRAVEL_MS); });
    return Math.max(READ_MS, end + 3000);
  }

  function clearMotion() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    traceLayer.replaceChildren();
    dotLayer.replaceChildren();
  }

  function pulse(id) {
    const n = nodeEl(id);
    if (!n) return;
    n.classList.remove('hit');
    n.getBBox(); // restart the CSS animation
    n.classList.add('hit');
  }

  // Lights boxes and lines. Lit lines are moved to the end of their layer so nothing dim
  // crosses over them.
  function light(nodeIds, pathIds, focusId) {
    svg.classList.add('is-running');
    svg.querySelectorAll('.f-node').forEach((n) => {
      const id = n.id.slice(2);
      n.classList.toggle('on', nodeIds.includes(id));
      n.classList.toggle('focus', id === focusId);
    });
    svg.querySelectorAll('.f-edge').forEach((e) => {
      const on = pathIds.includes(e.id.slice(2));
      e.classList.toggle('on', on);
      if (on) e.parentNode.appendChild(e);
    });
  }

  // Draws a gold copy of each line over the grey one, in step with a dot travelling along it.
  function trace(paths, instant) {
    clearMotion();
    const marker = svg.classList.contains('is-alert') ? 'url(#farr-alert)' : 'url(#farr-on)';
    const runs = paths.map(spec).map((q) => {
      const base = pathEl(q.id);
      const line = base.cloneNode(false);
      line.removeAttribute('id');
      line.setAttribute('class', 'f-trace');
      const len = base.getTotalLength();
      if (instant) {
        line.setAttribute('marker-end', marker);
        traceLayer.appendChild(line);
        return null;
      }
      line.removeAttribute('marker-end');
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
      traceLayer.appendChild(line);
      const glow = document.createElementNS(NS, 'circle');
      glow.setAttribute('r', '11');
      glow.setAttribute('class', 'f-glow');
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '4.5');
      dot.setAttribute('class', 'f-dot');
      glow.style.opacity = dot.style.opacity = 0;
      dotLayer.append(glow, dot);
      const [from, to] = q.id.split('-');
      return { ...q, base, line, len, glow, dot, from, to, arrived: false, done: false };
    }).filter(Boolean);
    if (!runs.length) return;

    let start = null;
    function frame(t) {
      if (start === null) start = t;
      let busy = false;
      runs.forEach((r) => {
        if (r.done) return;
        const local = (t - start - r.at) / (r.back ? 2 * TRAVEL_MS : TRAVEL_MS);
        if (local < 0) { busy = true; return; }
        const k = Math.min(local, 1);
        const out = r.back ? Math.min(k * 2, 1) : k;
        const pos = r.back && k > 0.5 ? ease(2 - k * 2) : ease(out);
        r.line.style.strokeDashoffset = r.len * (1 - ease(out));
        const pt = r.base.getPointAtLength(pos * r.len);
        const fade = Math.min(k / 0.06, (1 - k) / 0.06, 1);
        [r.dot, r.glow].forEach((c) => {
          c.setAttribute('cx', pt.x);
          c.setAttribute('cy', pt.y);
          c.style.opacity = Math.max(fade, 0);
        });
        if (!r.arrived && out >= 1) { r.arrived = true; pulse(r.to); r.line.setAttribute('marker-end', marker); }
        if (k >= 1) {
          r.done = true;
          if (r.back) pulse(r.from);
          r.dot.remove(); r.glow.remove();
        } else busy = true;
      });
      raf = busy ? requestAnimationFrame(frame) : null;
    }
    raf = requestAnimationFrame(frame);
  }

  // On a narrow screen the map scrolls sideways. Keep the step in view, or, when the step is
  // wider than the screen, the boxes its lines lead to.
  function follow(ids, targets) {
    if (canvas.scrollWidth <= canvas.clientWidth + 1) return;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    const span = (list) => {
      let lo = Infinity, hi = -Infinity;
      list.forEach((id) => {
        if (id === 'alert') return;
        const b = nodeEl(id).getBBox();
        lo = Math.min(lo, b.x); hi = Math.max(hi, b.x + b.width);
      });
      return lo === Infinity ? null : [lo, hi];
    };
    let s = span(ids);
    if (s && targets && targets.length && (s[1] - s[0]) * scale > canvas.clientWidth) s = span(targets) || s;
    if (!s) return;
    canvas.scrollTo({ left: Math.max(0, ((s[0] + s[1]) / 2) * scale - canvas.clientWidth / 2), behavior: reduced.matches ? 'auto' : 'smooth' });
  }

  function resetBar() {
    if (barAnim) barAnim.cancel();
    barAnim = null;
  }

  function runBar(ms) {
    resetBar();
    if (!playing || !visible || reduced.matches || !bar.animate) return;
    barAnim = bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: ms, easing: 'linear', fill: 'forwards' });
  }

  function render() {
    inspected = null;
    const flow = FLOWS[flowKey], s = flow.steps[step];
    svg.classList.toggle('is-alert', !!flow.alert);
    light(s.nodes, s.paths.map((p) => spec(p).id));
    tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.flow === flowKey)));
    stepEl.textContent = flow.name + ' · ' + (step + 1) + ' of ' + flow.steps.length;
    textEl.textContent = s.text;
    trace(s.paths, reduced.matches);
    follow(s.nodes, s.paths.map((p) => spec(p).id.split('-')[1]));
    schedule();
  }

  function inspect(id) {
    inspected = id;
    setPlaying(false);
    svg.classList.remove('is-alert');
    const edges = [...svg.querySelectorAll('.f-edge')].map((e) => e.id.slice(2)).filter((p) => p.split('-').includes(id));
    const near = new Set([id]);
    edges.forEach((p) => p.split('-').forEach((n) => near.add(n)));
    light([...near], edges, id);
    tabs.forEach((t) => t.setAttribute('aria-pressed', 'false'));
    stepEl.textContent = NODES[id][0];
    textEl.textContent = NODES[id][1];
    trace(edges, true);
    follow([id]);
  }

  function schedule() {
    clearTimeout(timer);
    if (inspected || !playing || !visible) { resetBar(); return; }
    const ms = stepMs(FLOWS[flowKey].steps[step]);
    runBar(ms);
    timer = setTimeout(advance, ms);
  }

  function advance() {
    if (!inspected) {
      if (step < FLOWS[flowKey].steps.length - 1) step++;
      else { flowKey = ORDER[(ORDER.indexOf(flowKey) + 1) % ORDER.length]; step = 0; }
    }
    render();
  }

  function back() {
    if (!inspected) {
      if (step > 0) step--;
      else { flowKey = ORDER[(ORDER.indexOf(flowKey) - 1 + ORDER.length) % ORDER.length]; step = FLOWS[flowKey].steps.length - 1; }
    }
    render();
  }

  function setPlaying(p) {
    playing = p;
    playBtn.textContent = p ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
    schedule();
  }

  tabs.forEach((t) => t.addEventListener('click', () => { flowKey = t.dataset.flow; step = 0; render(); }));
  fig.querySelector('[data-action="next"]').addEventListener('click', advance);
  fig.querySelector('[data-action="prev"]').addEventListener('click', back);
  playBtn.addEventListener('click', () => {
    const resume = !playing || inspected;
    if (inspected) render();
    setPlaying(!!resume);
  });
  svg.querySelectorAll('.f-node').forEach((n) => {
    const id = n.id.slice(2);
    n.addEventListener('click', () => inspect(id));
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspect(id); }
    });
  });
  fig.addEventListener('keydown', (e) => { if (e.key === 'Escape' && inspected) render(); });

  // Only run while on screen, so the page isn't animating something nobody is looking at.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      const was = visible;
      visible = entries[0].isIntersecting;
      if (visible && !was && !inspected) render();
      else schedule();
    }, { threshold: 0.3 }).observe(fig);
  } else {
    visible = true;
  }

  setPlaying(playing);
  render();
})();
