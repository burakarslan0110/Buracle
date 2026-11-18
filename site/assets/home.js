// The landing page in motion: the orbit lights one harness after another, the brain recalls one memory after another,
// the workflow ring runs its light round the phases and the router sends one question after another to its server.
// Every scene is whole in the HTML; this file only moves it and wires its controls. Nothing moves on its own under
// reduced motion, while a scene is off screen, while the page is hidden or after the visitor pressed pause; a scene the
// visitor has used stops its own tour so it never takes the choice back.
(function () {
  'use strict'
  var root = document.documentElement
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  var paused = false
  var canMove = function () { return !reduced.matches && !paused && document.visibilityState === 'visible' }
  var $ = function (sel, el) { return (el || document).querySelector(sel) }
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)) }

  // Is a scene on screen? Each scene reads its own flag before it moves.
  var seen = new WeakMap()
  var onScreen = function (el) { return seen.get(el) === true }
  var watch = function (el, cb) {
    if (!('IntersectionObserver' in window)) { seen.set(el, true); return }
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { seen.set(el, e.isIntersecting); if (cb) cb(e.isIntersecting) })
    }, { threshold: 0.2 }).observe(el)
  }

  // A tour: calls step() every `ms` while the scene is on screen and allowed to move, until the visitor takes over.
  function tour(el, ms, step) {
    var t = { user: false }
    watch(el)
    setInterval(function () { if (!t.user && onScreen(el) && canMove()) step() }, ms)
    return t
  }

  // ---- Reveal and the pause buttons ------------------------------------------------------------------------------
  if ('IntersectionObserver' in window) {
    root.classList.add('reveal-on')
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target) } })
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' })
    $$('.reveal').forEach(function (el) { io.observe(el) })
  }
  var toggles = $$('[data-motion-toggle]')
  function setPaused(p) {
    paused = p
    root.classList.toggle('is-paused', p)
    toggles.forEach(function (b) {
      b.setAttribute('aria-pressed', String(p))
      b.setAttribute('aria-label', p ? b.getAttribute('data-play') : b.getAttribute('data-pause'))
    })
  }
  toggles.forEach(function (b) {
    if (reduced.matches) return
    b.hidden = false
    b.addEventListener('click', function () { setPaused(!paused) })
  })

  // ---- Numbers: count up once when they come into view ----------------------------------------------------------
  var nums = $('.numbers')
  if (nums && 'IntersectionObserver' in window) {
    var counted = false
    new IntersectionObserver(function (entries) {
      if (counted || !entries[0].isIntersecting || !canMove()) return
      counted = true
      $$('[data-count]', nums).forEach(function (el) {
        var to = Number(el.getAttribute('data-count'))
        var t0 = performance.now()
        var tick = function (now) {
          var k = Math.min(1, (now - t0) / 900)
          el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))))
          if (k < 1) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    }, { threshold: 0.4 }).observe(nums)
  }

  // ---- 1. The orbit ------------------------------------------------------------------------------------------------
  var orbit = $('[data-orbit]')
  if (orbit) {
    var agents = $$('.agent', orbit)
    var lines = $$('.threads line', orbit)
    var caption = $('[data-orbit-caption]', orbit)
    var current = -1
    var pick = function (i, byUser) {
      current = i
      agents.forEach(function (a, k) { a.setAttribute('aria-pressed', String(k === i)) })
      // Each thread is two lines, the faint track and its spark: line 2k and 2k + 1 belong to harness k.
      lines.forEach(function (l, k) { l.classList.toggle('is-on', Math.floor(k / 2) === i) })
      var tpl = $('template[data-cap="' + agents[i].getAttribute('data-harness') + '"]', orbit)
      caption.setAttribute('aria-live', byUser ? 'polite' : 'off')
      if (tpl) { caption.innerHTML = ''; caption.appendChild(tpl.content.cloneNode(true)) }
    }
    var orbitTour = tour(orbit, 3400, function () { pick((current + 1) % agents.length, false) })
    agents.forEach(function (a, i) {
      a.addEventListener('click', function () { orbitTour.user = true; pick(i, true) })
    })
  }

  // ---- 3. The brain ------------------------------------------------------------------------------------------------
  var brain = $('[data-brain]')
  var card = $('[data-brain-card]')
  if (brain && card) {
    var svg = $('.brain-svg', brain)
    var mems = $$('.bm', brain)
    var links = $$('.bl[data-mems]', brain)
    // The tour alternates the halves, so both brains take turns.
    var proj = mems.filter(function (m) { return m.getAttribute('data-side') === 'project' })
    var pers = mems.filter(function (m) { return m.getAttribute('data-side') === 'person' })
    var order = []
    for (var i = 0; i < Math.max(proj.length, pers.length); i++) { if (proj[i]) order.push(proj[i]); if (pers[i]) order.push(pers[i]) }
    var at = 0
    var show = function (node) {
      var id = node.getAttribute('data-mem')
      var side = node.getAttribute('data-side')
      mems.forEach(function (m) { m.classList.toggle('is-on', m === node) })
      svg.style.setProperty('--sc', side === 'person' ? 'var(--color-eye)' : 'var(--color-accent)')
      links.forEach(function (l) { l.classList.toggle('is-on', (' ' + l.getAttribute('data-mems') + ' ').indexOf(' ' + id + ' ') >= 0) })
      var tpl = $('template[data-card="' + id + '"]')
      if (tpl) { card.innerHTML = ''; card.appendChild(tpl.content.cloneNode(true)); card.setAttribute('data-side', side) }
    }
    show(mems[0])
    var brainTour = tour(brain, 4200, function () { at = (at + 1) % order.length; show(order[at]) })
    var choose = function (node) { brainTour.user = true; card.setAttribute('aria-live', 'polite'); show(node) }
    mems.forEach(function (m, k) {
      m.addEventListener('click', function () { choose(m) })
      m.addEventListener('keydown', function (e) {
        var next = null
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(m); return }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = mems[(k + 1) % mems.length]
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = mems[(k - 1 + mems.length) % mems.length]
        if (e.key === 'Home') next = mems[0]
        if (e.key === 'End') next = mems[mems.length - 1]
        if (!next) return
        e.preventDefault()
        mems.forEach(function (x) { x.setAttribute('tabindex', x === next ? '0' : '-1') })
        next.focus()
        choose(next)
      })
    })
  }

  // ---- 4. The workflow rings ----------------------------------------------------------------------------------------
  $$('[data-tabs]').forEach(function (box) {
    var list = $('[role="tablist"]', box)
    var tabs = $$('[role="tab"]', box)
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')) })
    if (!list || tabs.length === 0) return
    list.hidden = false
    var select = function (i, focus) {
      tabs.forEach(function (t, k) {
        t.setAttribute('aria-selected', String(k === i))
        t.setAttribute('tabindex', k === i ? '0' : '-1')
        if (panels[k]) { if (k === i) panels[k].removeAttribute('data-later'); else panels[k].setAttribute('data-later', '') }
      })
      if (focus) tabs[i].focus()
      if (panels[i]) restart(panels[i])
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i, false) })
      t.addEventListener('keydown', function (e) {
        var k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key]
        if (k === undefined) return
        e.preventDefault()
        select((k + tabs.length) % tabs.length, true)
      })
    })
  })

  var loopsSec = $('#loops')
  var ringState = null
  function restart(panel) {
    var n = Number(panel.getAttribute('data-n'))
    ringState = {
      panel: panel, n: n, el: 0, shown: -1,
      dot: $('[data-dot]', panel), prog: $('[data-prog]', panel),
      nodes: $$('.rn', panel), phases: $$('.phase', panel),
      k: $('[data-rc-k]', panel), name: $('[data-rc-name]', panel), detail: $('[data-rc-detail]', panel),
    }
    place(0, 0)
  }
  var STEP = 1900
  var C = 260
  var R = 190
  function place(k, travel) {
    var s = ringState
    var a = (-90 + (360 * (k + travel)) / s.n) * Math.PI / 180
    s.dot.setAttribute('cx', String(C + R * Math.cos(a)))
    s.dot.setAttribute('cy', String(C + R * Math.sin(a)))
    s.prog.style.strokeDasharray = ((1000 * (k + travel)) / s.n) + ' 1000'
    if (s.shown === k) return
    s.shown = k
    s.nodes.forEach(function (nd, j) { nd.classList.toggle('is-past', j < k); nd.classList.toggle('is-now', j === k) })
    s.phases.forEach(function (p, j) { p.classList.toggle('is-now', j === k) })
    var ph = s.phases[k]
    if (!ph) return
    s.k.textContent = (k + 1) + ' / ' + s.n
    s.name.innerHTML = $('.phase-name', ph).innerHTML
    var d = $('.phase-detail', ph)
    s.detail.textContent = d ? d.textContent : ''
    // Re-run the swap animation on the readout.
    ;[s.name, s.detail].forEach(function (el) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '' })
  }
  if (loopsSec) {
    watch(loopsSec)
    var firstPanel = $('[data-loop]:not([data-later])', loopsSec)
    if (firstPanel) restart(firstPanel)
    var last = performance.now()
    var frame = function (now) {
      var s = ringState
      if (s && onScreen(loopsSec) && canMove()) {
        // Time only runs while the ring may move, so a pause holds the light where it is.
        var el = (s.el || 0) + Math.min(100, now - last)
        s.el = el
        var hold = STEP * (s.n + 0.8)
        var t = el % hold
        var k = Math.min(s.n - 1, Math.floor(t / STEP))
        var u = (t - k * STEP) / STEP
        var travel = k < s.n - 1 && u > 0.62 ? (function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2 })((u - 0.62) / 0.38) : 0
        place(k, travel)
      }
      last = now
      requestAnimationFrame(frame)
    }
    if (!reduced.matches) requestAnimationFrame(frame)
  }

  // ---- 5. The router -------------------------------------------------------------------------------------------------
  var router = $('[data-router]')
  if (router) {
    var stage = $('.router-stage', router)
    var beamSvg = $('.router-beam', router)
    var beam = $('[data-beam]', router)
    var beamDot = $('[data-beam-dot]', router)
    var answersBox = $('[data-answers]', router)
    var srvs = $$('.srv', router)
    var answers = $$('[data-answer]', router)
    var active = 0
    var draw = function () {
      if (getComputedStyle(beamSvg).display === 'none') return
      var box = stage.getBoundingClientRect()
      var face = $('.srv-face', srvs[active]).getBoundingClientRect()
      beamSvg.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height)
      var fx = box.width / 2
      var fy = 0
      var tx = face.left - box.left + face.width / 2
      var ty = face.top - box.top - 8
      beam.setAttribute('d', 'M' + fx + ' ' + fy + 'C' + fx + ' ' + (fy + (ty - fy) * 0.65) + ' ' + tx + ' ' + (fy + (ty - fy) * 0.25) + ' ' + tx + ' ' + ty)
    }
    // Named apart from the brain's chooser: `var` is shared by the whole file.
    var route = function (i, byUser) {
      active = i
      srvs.forEach(function (s, k) { s.setAttribute('aria-pressed', String(k === i)) })
      answers.forEach(function (a, k) { a.hidden = k !== i })
      answersBox.setAttribute('aria-live', byUser ? 'polite' : 'off')
      draw()
    }
    var routerTour = tour(router, 4600, function () { route((active + 1) % srvs.length, false) })
    srvs.forEach(function (s, i) { s.addEventListener('click', function () { routerTour.user = true; route(i, true) }) })
    window.addEventListener('resize', draw)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw)
    route(0, false)
    var beamFrame = function (now) {
      if (beam.getAttribute('d') && getComputedStyle(beamSvg).display !== 'none') {
        var len = beam.getTotalLength()
        var p = beam.getPointAtLength(canMove() ? ((now % 1600) / 1600) * len : len)
        beamDot.setAttribute('cx', String(p.x))
        beamDot.setAttribute('cy', String(p.y))
      }
      requestAnimationFrame(beamFrame)
    }
    requestAnimationFrame(beamFrame)
  }
})()
