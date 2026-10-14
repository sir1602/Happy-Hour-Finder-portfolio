/* eslint-env browser */
// Animated map of the n8n workflows on the case study. Each run is a list of steps; a step lights
// its nodes and lines and sends a dot along each line. Without JS the full map still shows.
(function () {
  let fig = document.getElementById('workflow-motion');
  if (!fig) return;
  fig.classList.add('is-live');
  let svg = fig.querySelector('svg');
  let dotsLayer = svg.querySelector('.f-dots');
  let NS = 'http://www.w3.org/2000/svg';
  let reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // "back" sends the dot there and back along one line: a call that returns its result.
  let FLOWS = {
    discover: { name: 'Find new venues', steps: [
      { nodes: ['wf3', 'wf5', 'engine'], paths: ['wf3-engine', 'wf5-engine'],
        text: 'Every Sunday, or from a form on my phone in a new city, the Area Scan Engine sweeps Google Maps and drops venues already on file.' },
      { nodes: ['engine', 'crawler'], paths: [{ id: 'engine-crawler', back: true }],
        text: 'Each new venue’s own website is crawled: up to six pages, picked by words like “happy hour” and “specials”. No model quota is spent yet.' },
      { nodes: ['engine', 'wf1'], paths: ['engine-wf1'],
        text: 'One Gemini call reads the evidence. Anything with a happy hour is posted to the intake API, the only door into the database.' },
      { nodes: ['wf1', 'db'], paths: ['wf1-db'],
        text: 'Intake dedupes, geocodes the address, and refuses a venue it can’t place rather than guess where it is.' },
      { nodes: ['db', 'active', 'pending'], paths: ['db-active', 'db-pending'],
        text: 'The publish gate runs in SQL. Confidence of 0.80 or more and a time window the app can parse go live. Everything else waits for a person.' }
    ] },
    recheck: { name: 'Nightly re-check', steps: [
      { nodes: ['wf2', 'crawler'], paths: [{ id: 'wf2-crawler', back: true }],
        text: 'At 4 AM, the 20 venues checked longest ago are crawled again. One crawl per venue, however many deals it has.' },
      { nodes: ['wf2', 'db'], paths: ['wf2-db'],
        text: 'Gemini compares the page with every stored deal. Each verdict is recorded through one SQL function that refuses unsafe edits.' },
      { nodes: ['wf2', 'probe'], paths: ['wf2-probe'],
        text: 'When plain HTTP can’t read a site, the Deep Probe asks Gemini to render the page or search for it.' },
      { nodes: ['probe', 'pending'], paths: ['probe-pending'],
        text: 'The probe can only file proposals for review. It has no write path to a live deal.' }
    ] },
    photo: { name: 'Menu photo', steps: [
      { nodes: ['app', 'wf1'], paths: ['app-wf1'],
        text: 'Someone photographs a menu board in the app. The photo goes to the intake API’s scan endpoint.' },
      { nodes: ['wf1', 'ocr'], paths: ['wf1-ocr'],
        text: 'Menu Photo OCR has Gemini read the board and puts the times into the app’s format.' },
      { nodes: ['ocr', 'app'], paths: ['ocr-app'],
        text: 'The fields go back to the person’s form, not the database. OCR misreads menus, so a person checks it first.' },
      { nodes: ['app', 'wf1', 'db'], paths: ['app-wf1', 'wf1-db'],
        text: 'When they submit, the deal takes the same path as every other source, publish gate included.' }
    ] },
    review: { name: 'Human review', steps: [
      { nodes: ['db', 'pending'], paths: ['db-pending'],
        text: 'Anything under the bar lands in the pending queue instead of the app.' },
      { nodes: ['pending', 'wf4'], paths: ['pending-wf4'],
        text: 'Every Monday an email lists what is waiting, and a live console shows the evidence beside each deal.' },
      { nodes: ['wf6', 'wf4'], paths: ['wf6-wf4'],
        text: 'Venue photos found by the artwork backfill wait here too, kept private until someone approves them.' },
      { nodes: ['wf4', 'db', 'active'], paths: ['wf4-db', 'db-active'],
        text: 'Approving takes a click and a confirm. Then the deal goes live.' }
    ] },
    failure: { name: 'When it breaks', steps: [
      { nodes: ['wf6', 'probe', 'wf4', 'alert'], paths: ['wf6-alert', 'probe-alert', 'wf4-alert'], alert: true,
        text: 'Every workflow names the Failure Alert as its error handler, so a crash, or a schedule that never fired, is reported instead of vanishing.' },
      { nodes: ['alert'], paths: [], alert: true,
        text: 'It sends a phone push first and an email second, so an expired email login can’t silence its own alarm.' }
    ] }
  };

  let STEP_MS = 4600, TRAVEL_MS = 1300;
  let tabs = fig.querySelectorAll('.flow-tab');
  let stepEl = fig.querySelector('.flow-step');
  let textEl = fig.querySelector('.flow-text');
  let playBtn = fig.querySelector('[data-action="play"]');
  let order = Object.keys(FLOWS);
  let flowKey = order[0], step = 0, playing = !reduced.matches, visible = false;
  let timer = null, raf = null;

  function el(id) { return svg.getElementById ? svg.getElementById(id) : document.getElementById(id); }

  function clearDots() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    while (dotsLayer.firstChild) dotsLayer.removeChild(dotsLayer.firstChild);
  }

  function animateDots(paths) {
    clearDots();
    if (reduced.matches || !paths.length) return;
    let runs = paths.map(function (p) {
      let spec = typeof p === 'string' ? { id: p } : p;
      let path = el('p-' + spec.id);
      let dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '5');
      dot.setAttribute('class', 'f-dot');
      dotsLayer.appendChild(dot);
      return { path: path, len: path.getTotalLength(), back: spec.back, dot: dot };
    });
    let start = null;
    function frame(t) {
      if (start === null) start = t;
      let done = true;
      runs.forEach(function (r) {
        let total = r.back ? TRAVEL_MS * 2 : TRAVEL_MS;
        let k = Math.min((t - start) / total, 1);
        if (k < 1) done = false;
        let pos = r.back ? (k < 0.5 ? k * 2 : 2 - k * 2) : k;
        pos = pos < 0.5 ? 2 * pos * pos : 1 - Math.pow(-2 * pos + 2, 2) / 2;
        let pt = r.path.getPointAtLength(pos * r.len);
        r.dot.setAttribute('cx', pt.x);
        r.dot.setAttribute('cy', pt.y);
        r.dot.style.opacity = k >= 1 ? 0 : 1;
      });
      raf = done ? null : requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  function render() {
    let flow = FLOWS[flowKey], s = flow.steps[step];
    svg.classList.add('is-running');
    svg.classList.toggle('is-alert', !!s.alert);
    svg.querySelectorAll('.f-node').forEach(function (n) {
      n.classList.toggle('on', s.nodes.indexOf(n.id.slice(2)) !== -1);
    });
    let ids = s.paths.map(function (p) { return typeof p === 'string' ? p : p.id; });
    svg.querySelectorAll('.f-paths path').forEach(function (p) {
      let on = ids.indexOf(p.id.slice(2)) !== -1;
      p.classList.toggle('on', on);
      p.setAttribute('marker-end', on ? 'url(#farr-on)' : 'url(#farr)');
    });
    tabs.forEach(function (t) { t.setAttribute('aria-pressed', String(t.dataset.flow === flowKey)); });
    stepEl.textContent = flow.name + ' · ' + (step + 1) + ' of ' + flow.steps.length;
    textEl.textContent = s.text;
    animateDots(s.paths);
    follow(s.nodes);
  }

  // On a narrow screen the map scrolls sideways; keep the lit nodes in view.
  let canvas = fig.querySelector('.flow-canvas');
  function follow(nodes) {
    if (canvas.scrollWidth <= canvas.clientWidth + 1) return;
    let minX = Infinity, maxX = -Infinity;
    nodes.forEach(function (id) {
      let b = el('n-' + id).getBBox();
      minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.width);
    });
    let scale = svg.getBoundingClientRect().width / 980;
    let left = ((minX + maxX) / 2) * scale - canvas.clientWidth / 2;
    canvas.scrollTo({ left: Math.max(0, left), behavior: reduced.matches ? 'auto' : 'smooth' });
  }

  function schedule() {
    clearTimeout(timer);
    if (playing && visible) timer = setTimeout(advance, STEP_MS);
  }

  function advance() {
    let flow = FLOWS[flowKey];
    if (step < flow.steps.length - 1) step++;
    else { flowKey = order[(order.indexOf(flowKey) + 1) % order.length]; step = 0; }
    render(); schedule();
  }

  function back() {
    if (step > 0) step--;
    else {
      flowKey = order[(order.indexOf(flowKey) - 1 + order.length) % order.length];
      step = FLOWS[flowKey].steps.length - 1;
    }
    render(); schedule();
  }

  function setPlaying(p) {
    playing = p;
    playBtn.textContent = p ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
    schedule();
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { flowKey = t.dataset.flow; step = 0; render(); schedule(); });
  });
  fig.querySelector('[data-action="next"]').addEventListener('click', advance);
  fig.querySelector('[data-action="prev"]').addEventListener('click', back);
  playBtn.addEventListener('click', function () { setPlaying(!playing); });

  // Only run while on screen, so the page isn't animating something nobody is looking at.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) render();
      schedule();
    }, { threshold: 0.3 }).observe(fig);
  } else { visible = true; }

  setPlaying(playing);
  render();
})();
