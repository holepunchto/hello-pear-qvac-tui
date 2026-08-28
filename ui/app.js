// The TUI — a bare-tui model for an ask/answer session against a local model.
//
// It is a plain Elm-architecture model: state in the constructor, messages
// folded in update(), a pure view(). It never touches the QVAC SDK directly.
// Inference arrives as messages ('qvac.delta', 'qvac.end', ...) that bin.mjs
// forwards from the worker, and outgoing requests leave through Cmds. That
// split is what makes this file testable with no model, no GPU and no
// terminal — see test/index.js.
const { quit, batch, key, style, spinner, textinput, viewport, progress } = require('bare-tui')
const updater = require('bare-tui-updater')

const ACCENT = '#5BC8FF'
const ACCENT_2 = '#7AA2F7'

// The banner's own accept key. bare-tui-updater defaults to 'u' and also
// accepts 'enter' — both of which this app needs for typing and sending, so we
// claim a chord the text field will never see.
const ACCEPT_KEY = 'ctrl+r'

const MIN_WIDTH = 24
// Header (4 rows) + footer (4) + at least one body row. Below this the view
// would be taller than the terminal, which scrolls it and desyncs the diff
// renderer's row addressing.
const MIN_HEIGHT = 10

// Word-wrap plain text to a column width. Measures visible cells, so it stays
// correct once the text has color in it.
function wrap(text, w) {
  const out = []

  for (const para of String(text).split('\n')) {
    if (para === '') {
      out.push('')
      continue
    }

    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      if (line && style.width(line) + 1 + style.width(word) > w) {
        out.push(line)
        line = word
      } else {
        line = line ? line + ' ' + word : word
      }
    }
    out.push(line)
  }

  return out
}

class App {
  constructor({ inference, model, version, onApplyUpdate } = {}) {
    this.inference = inference || null
    this.model = model || 'local model'
    this.version = version || '0.0.0'

    this.width = 80
    this.height = 24

    // 'loading' -> the model is downloading/loading; 'idle' -> accepting input;
    // 'busy' -> an answer is streaming back; 'failed' -> the model never loaded.
    this.phase = 'loading'
    this.percentage = 0
    this.ctxSize = 0

    // Reasoning is shown live while the model thinks, then collapses to a
    // one-line summary. ctrl+t brings it back.
    this.showThinking = false

    this.entries = []
    this.askId = null // id of the in-flight answer, null when idle

    this.spinner = spinner.create({ frames: spinner.dots, fps: 12 })
    this.body = viewport.create({ width: 0, height: 10 })
    this.bar = progress.create({ width: 44, gradient: ['#43E97B', ACCENT] })
    this.input = textinput.create({
      prompt: '',
      placeholder: 'ask the model something…'
    })

    // Costs zero rows until there is an update to announce. `border: false`
    // asks for a single status line rather than a box under a UI that is
    // already box-heavy; versions that don't know the option draw a box and
    // the layout adapts, because we measure the banner rather than assume it.
    this.updater = updater.create({
      mode: 'confirm',
      border: false,
      acceptKey: ACCEPT_KEY,
      onAccept: onApplyUpdate || null
    })

    this.follow = true

    // Placeholder chrome heights for the single frame drawn before the first
    // resize; _layout() measures the real ones from here on.
    this.headerH = 4
    this.footerH = 4
  }

  init() {
    return this.spinner.init()
  }

  // ── messages ─────────────────────────────────────────────────────────────

  update(msg) {
    switch (msg.type) {
      case 'resize':
        // Clamp: a detached or half-initialised terminal can report 0, and a
        // negative box width throws inside the styler.
        this.width = Math.max(MIN_WIDTH, msg.width || MIN_WIDTH)
        this.height = Math.max(MIN_HEIGHT, msg.height || MIN_HEIGHT)
        // Size the banner to the terminal so its text isn't truncated. Both
        // properties are plain fields; the second is only read by versions
        // that support alignment.
        this.updater.width = Math.max(40, Math.min(this.width - 4, 78))
        this.updater.containerWidth = this.width
        this._layout()
        this._sync()
        return [this, null]

      case 'spinner.tick': {
        // Both spinners take ticks. Each ignores the other's (they carry an id),
        // but the banner's would be dropped if we returned early here.
        const [s, cmd] = this.spinner.update(msg)
        this.spinner = s
        // Only the transcript's own spinner needs a re-wrap; the footer/header
        // read this.spinner directly in view().
        if (this.phase === 'busy') this._sync()
        return [this, batch(cmd, this._banner(msg))]
      }

      case 'update.downloading':
      case 'update.progress':
      case 'update.ready':
      case 'update.apply':
      case 'update.applied':
      case 'update.error':
      case 'update.dismiss':
      case 'update.hide':
        return [this, this._banner(msg)]

      case 'qvac.progress':
        this.percentage = msg.percentage
        return [this, null]

      case 'qvac.loaded':
        this.phase = 'idle'
        this.model = msg.model || this.model
        this.ctxSize = msg.ctxSize || this.ctxSize
        this.input.focus()
        this._note(
          `${this.model} loaded${this.ctxSize ? ` · ${this.ctxSize} token context` : ''} — ask it anything.`
        )
        this._layout()
        this._sync()
        return [this, null]

      case 'qvac.thinking': {
        if (msg.id !== this.askId) return [this, null] // stale: interrupted or superseded
        const last = this._answer()
        if (last) last.thinking += msg.text
        this._sync()
        return [this, null]
      }

      case 'qvac.delta': {
        if (msg.id !== this.askId) return [this, null] // stale: interrupted or superseded
        const last = this._answer()
        if (last) {
          // First content token ends the thinking phase — record how long it
          // took so the collapsed line has something to say.
          if (!last.text && last.thinking) last.thoughtMs = Date.now() - last.startedAt
          last.text += msg.text
        }
        this._sync()
        return [this, null]
      }

      case 'qvac.end': {
        if (msg.id !== this.askId) return [this, null]
        // 'length' means the model ran out of context mid-sentence. Saying so
        // is the whole point — a silently truncated answer reads like a bad model.
        const last = this._answer()
        if (last && msg.stopReason === 'length') last.truncated = true
        return [this._settle(), null]
      }

      case 'qvac.error':
        if (msg.id !== undefined && msg.id !== this.askId) return [this, null]
        this._note(`error: ${msg.message}`, 'red')

        // An error before the model ever loaded ends the session — there is
        // nothing to ask. A later one just ends the answer in flight.
        if (this.phase === 'loading') {
          this.phase = 'failed'
          this._layout()
          this._sync()
          return [this, null]
        }

        return [this._settle(), null]

      // Anything the app wants to drop into the transcript — OTA updater
      // progress, worker warnings.
      case 'app.notice':
        this._note(msg.text)
        this._sync()
        return [this, null]

      case 'mouse':
        if (msg.action === 'wheel') {
          if (msg.button === 'wheelup') this.body.scrollUp(3)
          else this.body.scrollDown(3)
          this.follow = this.body.atBottom
        }
        return [this, null]

      case 'key':
        return this._key(msg)

      default:
        return [this, null]
    }
  }

  _key(msg) {
    // Global keys first, so a busy state or a child component can never
    // swallow the escape hatch.
    if (key.matches(msg, 'ctrl+c')) {
      if (this.phase === 'busy') return this._interrupt()
      return [this, quit]
    }

    // The banner sees only the two keys it owns, and only while it is showing
    // something. Its built-in 'enter' accept would otherwise swallow the key
    // that sends a question, and 'u' would be eaten mid-word.
    if (this.updater.visible()) {
      const dismissing = key.matches(msg, 'esc') && this.phase !== 'busy'
      if (key.matches(msg, ACCEPT_KEY) || dismissing) return [this, this._banner(msg)]
    }

    // Reasoning is collapsed by default; this reveals it for every answer.
    if (key.matches(msg, 'ctrl+t')) {
      this.showThinking = !this.showThinking
      this._sync()
      return [this, null]
    }

    // Scrolling always works, in every phase.
    if (key.matches(msg, 'pageup', 'pagedown', 'ctrl+u', 'ctrl+d')) {
      this.body.update(msg)
      this.follow = this.body.atBottom
      return [this, null]
    }

    if (this.phase === 'busy') {
      if (key.matches(msg, 'esc')) return this._interrupt()
      return [this, null] // input is inert while the model is answering
    }

    if (this.phase !== 'idle') return [this, null]

    if (key.matches(msg, 'enter')) return this._submit()

    const [input, cmd] = this.input.update(msg)
    this.input = input
    return [this, cmd]
  }

  // ── actions ──────────────────────────────────────────────────────────────

  _submit() {
    const text = this.input.value.trim()
    if (!text) return [this, null]

    this.input.reset()
    this.entries.push({ role: 'user', text })
    this.entries.push({
      role: 'assistant',
      text: '',
      thinking: '',
      thoughtMs: 0,
      startedAt: Date.now(),
      interrupted: false,
      truncated: false
    })

    // The whole conversation goes back every turn, so the model has context.
    // `text` is answer content only — reasoning is deliberately left out. A
    // thinking model's `<think>` blocks are per-turn scratch work; replaying
    // them burns the context window that the next answer needs.
    const history = this.entries
      .filter((e) => e.role === 'user' || (e.role === 'assistant' && e.text))
      .map((e) => ({ role: e.role, content: e.text }))

    this.phase = 'busy'
    this.input.blur()
    this.follow = true
    this._layout()
    this._sync()

    // Talk to the worker from a Cmd, never inline in update(). The answer
    // comes back as 'qvac.delta' messages via the bridge in bin.mjs.
    return [
      this,
      () => {
        this.askId = this.inference ? this.inference.ask(history) : null
        return null
      }
    ]
  }

  // The answer currently being written, if there is one.
  _answer() {
    const last = this.entries[this.entries.length - 1]
    return last && last.role === 'assistant' ? last : null
  }

  _interrupt() {
    const id = this.askId
    const last = this.entries[this.entries.length - 1]
    if (last && last.role === 'assistant') last.interrupted = true

    this._settle()

    return [
      this,
      () => {
        if (this.inference && id !== null) this.inference.cancel(id)
        return null
      }
    ]
  }

  // Return to idle: drop the in-flight id so late deltas are ignored, and give
  // the field its focus back.
  _settle() {
    this.askId = null
    this.phase = 'idle'
    this.input.focus()
    this._layout()
    this._sync()
    return this
  }

  // Route one message into the banner. It grows and shrinks as it appears and
  // disappears, so re-measure the layout whenever its size actually changed.
  _banner(msg) {
    const before = this._bannerHeight()
    const [u, cmd] = this.updater.update(msg)
    this.updater = u

    if (this._bannerHeight() !== before) {
      this._layout()
      this._sync()
    }

    return cmd
  }

  // The banner renders to '' while idle. Measure what it actually produces
  // rather than assuming a row count — it is 1 line or 3 depending on whether
  // the installed version supports borderless mode.
  _bannerHeight() {
    const view = this.updater.view()
    return view ? style.height(view) : 0
  }

  _note(text, color) {
    this.entries.push({ role: 'system', text, color: color || null })
  }

  // ── layout ───────────────────────────────────────────────────────────────

  // Measure the chrome rather than counting its lines — a hardcoded constant
  // goes stale the moment the header or footer grows, and the body then
  // overflows the terminal and desyncs the diff renderer.
  _layout() {
    this.headerH = style.height(this._header())
    this.footerH = style.height(this._footer())
    // Whatever the chrome leaves, never zero. Measured, never counted — see
    // bare-tui's CLAUDE.md on why a hardcoded line count goes stale. The
    // banner is chrome too: 0 rows idle, 1 when it has something to say.
    this.body.height = Math.max(1, this.height - this.headerH - this.footerH - this._bannerHeight())
    this.bar.setWidth(Math.max(20, Math.min(52, this.width - 12)))
  }

  _sync() {
    this.body.setContent(this._transcript())
    if (this.follow) this.body.gotoBottom()
  }

  _transcript() {
    const w = Math.max(20, this.width - 6)
    // The answer being written changes every token and animates a spinner, so
    // it is rebuilt each frame. Everything above it is finished text.
    const live = this.phase === 'busy' ? this.entries.length - 1 : -1

    const out = []
    for (let i = 0; i < this.entries.length; i++) {
      if (out.length) out.push('')
      for (const line of this._entryLines(this.entries[i], w, i === live)) out.push(line)
    }

    return out.map((line) => ' ' + line).join('\n')
  }

  // Wrapping is the expensive part of a frame, and a thinking model emits on
  // the order of a thousand deltas per answer. Re-wrapping the whole
  // transcript each time is quadratic in conversation length, so finished
  // entries are wrapped once and cached against everything that affects how
  // they render.
  _entryLines(e, w, live) {
    if (live) return this._buildEntry(e, w)

    const sig = [
      w,
      e.role,
      e.text.length,
      e.thinking ? e.thinking.length : 0,
      e.thoughtMs || 0,
      e.interrupted ? 1 : 0,
      e.truncated ? 1 : 0,
      e.color || '',
      this.showThinking ? 1 : 0,
      this.ctxSize
    ].join('|')

    if (e._sig !== sig) {
      e._lines = this._buildEntry(e, w)
      e._sig = sig
    }

    return e._lines
  }

  _buildEntry(e, w) {
    const out = []
    const push = (s) => out.push(s)

    if (e.role === 'user') {
      const lines = wrap(e.text, w - 2)
      const mark = style().bold(true).foreground(ACCENT).render('❯')
      push(
        `${mark} ${style()
          .bold(true)
          .render(lines[0] || '')}`
      )
      for (const l of lines.slice(1)) push('  ' + l)
      return out
    }

    if (e.role === 'system') {
      for (const l of wrap(e.text, w)) {
        push(
          style()
            .faint(true)
            .foreground(e.color || null)
            .render(l)
        )
      }
      return out
    }

    // assistant
    this._renderThinking(e, push, w)

    if (!e.text && !e.thinking) {
      push(
        style().foreground(ACCENT).render(this.spinner.view()) +
          ' ' +
          style().italic(true).faint(true).render('thinking…')
      )
    } else if (e.text) {
      for (const l of wrap(e.text, w)) push(l)
    }

    if (e.interrupted) push(style().foreground('red').render('⎚ interrupted'))

    if (e.truncated) {
      push(
        style()
          .foreground('yellow')
          .render(`⚠ stopped at the ${this.ctxSize || ''} token context limit`) +
          style().faint(true).render(' — raise --ctx, or start a new question')
      )
    }

    return out
  }

  // Reasoning streams live while the model works, then collapses to one line
  // once the answer starts. ctrl+t expands it again.
  _renderThinking(e, push, w) {
    if (!e.thinking) return

    const streaming = !e.text
    if (streaming || this.showThinking) {
      const head = streaming
        ? style().foreground(ACCENT).render(this.spinner.view())
        : style().faint(true).render('✻')
      push(head + ' ' + style().italic(true).faint(true).render('thinking'))
      for (const l of wrap(e.thinking, w - 2)) push('  ' + style().faint(true).render(l))
      if (!streaming) push('')
      return
    }

    const took = e.thoughtMs ? ` for ${(e.thoughtMs / 1000).toFixed(1)}s` : ''
    push(style().faint(true).render(`✻ thought${took} · ctrl+t to show`))
  }

  // ── view ─────────────────────────────────────────────────────────────────

  view() {
    // filter(Boolean) is load-bearing: the banner is '' while idle, and an
    // empty string would still occupy a row here.
    return [this._header(), this.body.view(), this._footer(), this.updater.view()]
      .filter(Boolean)
      .join('\n')
  }

  _header() {
    const title =
      style().bold(true).foreground(ACCENT).render('◆ hello-pear-qvac') +
      style().faint(true).render(`  v${this.version}`)
    const meta =
      style().faint(true).render('model ') +
      style().foreground(ACCENT_2).render(this.model) +
      style().faint(true).render('   ') +
      this._status()

    return style()
      .width(this.width - 4)
      .padding(0, 1)
      .border(style.borders.rounded)
      .borderForeground(ACCENT)
      .render(style.joinVertical(style.position.left, title, meta))
  }

  _status() {
    if (this.phase === 'loading') return style().foreground('yellow').render('loading')
    if (this.phase === 'failed') return style().foreground('red').render('failed')
    if (this.phase === 'busy') return style().foreground(ACCENT).render('answering')
    return style().foreground('green').render('ready')
  }

  _footer() {
    const w = this.width - 4
    let inner
    let border

    if (this.phase === 'loading') {
      inner =
        style().foreground(ACCENT).render(this.spinner.view()) +
        ' ' +
        this.bar.view(this.percentage / 100) +
        style().faint(true).render('  fetching weights')
      border = 'gray'
    } else if (this.phase === 'failed') {
      inner = style().foreground('red').render('✖ the model could not be loaded')
      border = 'red'
    } else if (this.phase === 'busy') {
      inner =
        style().foreground(ACCENT).render(this.spinner.view()) +
        ' ' +
        style().italic(true).render('answering…') +
        style().faint(true).render('   esc to interrupt')
      border = 'gray'
    } else {
      inner = style().bold(true).foreground(ACCENT).render('❯ ') + this.input.view()
      border = ACCENT
    }

    const box = style()
      .width(w)
      .padding(0, 1)
      .border(style.borders.rounded)
      .borderForeground(border)
      .render(inner)

    let hint = '  esc interrupts · ctrl+c quit'
    if (this.phase === 'idle') hint = '  ↵ send · ctrl+t thinking · pgup/pgdn scroll · ctrl+c quit'
    else if (this.phase === 'failed') hint = '  ctrl+c quit'

    return style.joinVertical(style.position.left, box, style().faint(true).render(hint))
  }
}

module.exports = { App, wrap }
