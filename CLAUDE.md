# Building apps from hello-pear-qvac

Guidance for an AI (or human) turning this template into a real app. This is
not API reference — the [README](README.md) covers the architecture, and the
files are short and meant to be read. This captures the decisions you'll face
and the traps that have already been hit and fixed here, so you don't
re-discover them the hard way.

Dependencies carry their own guidance worth reading before you touch the
matching layer: [bare-tui's CLAUDE.md][bare-tui-claude] for the UI, and
[bare-tui-updater's README][bare-tui-updater] for the update banner.

## What this template is

A terminal chat app where the model runs locally. Three moving parts:

```
bin.mjs                    CLI + the only place workers meet the UI
   ├── app.js ──────────── workers/main.js     OTA updates    (Bare thread)
   ├── lib/inference.js ── workers/qvac.js     @qvac/inference (Bare thread)
   └── ui/app.js                               bare-tui model + update banner
          └── ui/transcript.js                 drawing one entry (pure)
```

The README's [How one question flows](README.md#how-one-question-flows) traces a
single keystroke through all four layers, naming the function at each hop. Read
it once before changing anything that crosses a layer.

**The load-bearing idea is that `ui/app.js` never imports the QVAC SDK.**
Inference arrives as messages (`qvac.delta`, `qvac.end`, …) that `bin.mjs`
forwards from the worker; requests leave through Cmds. Keep that boundary and
the entire UI stays testable with no model, no GPU and no terminal — the suite
runs in ~150 ms. Break it and you've traded a fast test suite for a 4-second
one that needs a working GPU.

When you add a feature, the question to ask first is **which of the three
layers owns it**:

| Change                                        | Touch                                                        |
| --------------------------------------------- | ------------------------------------------------------------ |
| How something looks, or a new key             | `ui/app.js` (`ui/transcript.js` for entry drawing)           |
| What the model is asked, tools, system prompt | `workers/qvac.js` (+ protocol)                               |
| A new kind of event reaching the UI           | worker → `lib/inference.js` → `bin.mjs` bridge → `ui/app.js` |

## Module types: this repo is deliberately mixed

`package.json` has no `"type"`, so **`.js` files are CommonJS**. `bin.mjs` is
ESM because `.mjs` always is. `bare-tui` and `bare-tui-updater` are CJS.
`@qvac/inference` is **ESM-only**.

That last one is why `workers/qvac.js` is CJS but reaches the SDK through
`await import(...)` inside `boot()` rather than a top-level `require`. Don't
"tidy" that into a require — it will not resolve. And don't flip the package to
`"type": "module"` to avoid it: `app.js`, `workers/main.js`, `lib/`, `ui/` and
`test/` are all `require`-based, as is the `hello-pear-bare` template this
tracks, so the flip breaks every one of them to fix one dynamic import.

If you add a file, match its neighbours: `.js` under `lib/`, `ui/`, `workers/`
is CJS; only `bin.mjs` is ESM.

This template tracks [hello-pear-bare][hello-pear-bare], so keep diffs against it
small. One deliberate divergence: `corestore`, `hyperswarm` and
`graceful-goodbye` are **not** dependencies here. Nothing in this repo imports
them and `hello-pear-worker` declares all three itself, so they were dropped to
keep the dependency list equal to what the app actually uses. Don't add them back
during a template sync without a reason.

## The worker protocol is the contract

One JSON object per `FramedStream` frame, `t` is the tag, `id` correlates an
answer with the request that asked for it. Both directions are listed in
[workers/qvac.js](workers/qvac.js)'s header comment — keep it current when you
extend the protocol, it's the first thing anyone reads.

When adding a message type, touch all four places or it silently does nothing:

1. `workers/qvac.js` — produce it
2. `lib/inference.js` `_onmessage` — turn the frame into an event
3. `bin.mjs` bridge — forward the event as a Program message
4. `ui/app.js` `update()` — fold it into state

**Everything crossing the pipe must be JSON-serialisable.** No streams, no
class instances, no functions. If you want to hand the UI a `CompletionRun`,
you can't — send its `requestId` and keep the run in the worker's `inflight`
map, which is exactly what cancellation does.

## Traps that have already bitten this repo

These are not hypothetical. Each was hit, diagnosed and fixed here; the fix is
in the code with a comment. Don't undo them.

### The app hangs forever on exit if the model isn't unloaded

A resident GGUF holds native handles that keep the process alive. Without the
`close` handshake — worker unloads and replies `closed`, client waits with a
grace period — the app never exits. Symptom: everything works, then your
terminal never comes back.

If you add another resource in the worker (a second model, a RAG store), unload
it in `shutdown()` too.

### llama.cpp's stderr banner cannot be silenced

`ggml_vulkan: Found 1 Vulkan devices…` and friends are raw `fprintf(stderr)`
from C++, below any JS logger. Verified: `@qvac/llm-llamacpp/addonLogging`'s
`setLogger` captures **zero** of them, and `modelConfig.verbosity` doesn't gate
them. Bare has no `dup2`, and the worker is a _thread_, so it shares fd 2.

They land on the alt-screen and the diff renderer won't repair them, because it
only repaints rows it thinks changed. So `bin.mjs` repairs deliberately:
`program.renderer.clear()` on `loaded` forces a full repaint. If you ever see
garbage on screen after some other native call, that's the tool.

Don't spend time trying to suppress them at the source. It has been tried.

### `run.events` ending is not the same as the answer finishing

This one silently produced wrong output for a while. `for await (const e of
run.events)` completes **normally** when a completion fails mid-stream or stops
because it ran out of context. The reason lives on `run.final`, which the SDK
rejects on failure and resolves with a `stopReason` otherwise (`undefined` or
`'eos'` on a clean finish, `'length'` when it ran out of room).

A worker that only reads `contentDelta` and then reports "done" turns a
truncated answer into an apparently complete one, and the user blames the
model. So `ask()` awaits `final`, forwards `stopReason`, and treats
`InferenceCancelledError` as an outcome rather than a failure. Keep that if you
rewrite the loop.

The SDK attaches its own no-op `.catch` to `final`, so a rejection won't crash
the worker — it will just be invisible. That's worse.

### The default context window is 1024 tokens

Not a typo. `promptTokens + generatedTokens` is capped at the context size, so
with the default the _first_ answer gets ~990 tokens and each later turn gets
less as the history grows — which reads exactly like "long answers get
truncated, and it's worse on the second or third one".

`workers/qvac.js` sets `ctx_size` from `--ctx` / `qvac.ctxSize` (8192 here).
If you change the model, sanity-check that the value still suits it, and
remember that everything the model holds at once — conversation, reasoning, and
the answer being written — shares that budget.

### Reasoning must not go back as history

With `captureThinking: true` a thinking model's `<think>` block arrives as
`thinkingDelta` events, separate from `contentDelta`. Without it the tags land
verbatim in the content.

The UI keeps them in separate fields and **sends only content back as
history**. Reasoning is per-turn scratch work; replaying it is the fastest way
to fill the context window, and it compounds every turn. If you touch the
history builder in `_submit()`, keep it reading `e.text`, never `e.thinking`.

### Model loading blocks its thread; generation doesn't

Measured: generation keeps ~100% of timer ticks — it's genuinely async, so the
spinner animates through it. Loading blocks ~40% of the loop _on its own
thread_, which the UI thread survives (~85% of ticks). That's why loading is in
a worker at all.

Two consequences: don't move loading back into the UI process to "simplify",
and don't add heavy synchronous work to `workers/qvac.js` expecting the UI to
stay smooth — it shares that thread with the model load.

### A worker that throws kills the process, uncatchably

`pear-runtime` turns an uncaught error inside a worker thread into
`console.error` + `Bare.exit(1)`. No `try/catch` in `bin.mjs` can intercept it,
and it happens _after_ the TUI has painted, so it wrecks the terminal.

So both workers catch at their top level and report over the pipe instead
(`boot().catch(...)` in `workers/qvac.js`). Any new async entrypoint in a worker
needs the same treatment. This is also why `bin.mjs` refuses to start the
updater while `package.json`'s `upgrade` is still the placeholder — that path
throws inside the worker.

### Stale async results

Every answer carries an `id`. `ui/app.js` drops any `qvac.delta`/`end`/`error`
whose `id` isn't the current `askId`, and `_settle()` clears `askId` so a late
token from an interrupted run can't append itself to the next answer. This is
bare-tui's generation-id pattern; keep it if you add another async source.

### The update banner's default keys collide with typing

`bare-tui-updater` accepts on `enter` **as well as** its accept key, and
defaults that key to `u`. In an app where `enter` sends a question and `u` is an
ordinary letter, wiring it naively means enter applies an update instead of
asking your question, and typing "update" fires it mid-word.

The fix here: `acceptKey: 'ctrl+r'`, and `_key()` forwards _only_ the accept
chord and a dismiss `esc` to the banner, never the general key stream. If you
add a component that wants keys, follow the same rule — route explicitly rather
than broadcasting.

### Both spinners need the same tick

The transcript spinner and the banner's spinner both consume `spinner.tick`.
Each ignores the other's (ticks carry an id), but an early `return` in the
`spinner.tick` case would starve one of them. They're `batch`ed to both.

## Layout: measure, never count

The view must be **exactly** as tall as the terminal. One line too many and the
terminal scrolls, after which the diff renderer's absolute row addressing is
wrong and the screen visibly jumps on the next keystroke.

So `_layout()` measures real rendered chrome with `style.height()` and gives the
rest to the viewport. There are tests asserting the view is exactly N rows at
several heights — **if you add a line to the header or footer, they keep
passing**, which is the whole point. If you replace them with a hardcoded
`height - 8`, you've reintroduced the bug the tests were written for.

Three specific things:

- **The update banner is chrome too.** 0 rows idle, 1 or 3 when visible
  depending on the installed version. `_bannerHeight()` measures what it
  actually renders rather than assuming, and `_layout()` subtracts it. The
  single-line look needs a `bare-tui-updater` newer than the published `0.0.1`;
  `border: false` is passed already, so it appears on upgrade with no code
  change — which is exactly why the height is measured and not hardcoded.
- **`.filter(Boolean)` in `view()` is load-bearing.** The banner renders `''`
  when idle, and an empty string still occupies a row when joined.
- **Clamp the terminal size.** A detached or half-initialised terminal reports
  0, and a negative box width throws inside the styler. `MIN_WIDTH`/
  `MIN_HEIGHT` exist because that crashed here.

Transcript content is styled, so the viewport is created with `width: 0` and
the text is pre-wrapped by `wrap()`, which measures visible cells. Never use
`.length` or `.slice` on styled strings.

**Wrapping is the expensive part of a frame**, and a thinking model emits on the
order of a thousand deltas per answer. Re-wrapping the whole transcript on each
one is quadratic in conversation length — measured at 3.7 ms/delta with no
history rising to 7.2 ms at six turns. `entryLines()` in
[ui/transcript.js](ui/transcript.js) caches finished entries against a signature
of everything that affects their rendering, which flattens it to ~3.3 ms
regardless of depth. The live entry is never cached, because its spinner
animates.

That file is pure: entry in, styled lines out, all app state arriving in an
`opts` object built once per frame by `_transcript()`. **If you add anything to
`opts`, or a field that changes how an entry looks, add it to the signature
too** — otherwise the entry keeps rendering its stale version.

## Extending it

### A different model

`--model NAME`, or `qvac.model` in `package.json`. Any model constant exported
by `@qvac/inference` works. Nothing else changes.

### A different modality

`workers/qvac.js` registers exactly one plugin — nothing you don't register is
linked in. Swap the plugin, then **install its peer dependency**, which npm will
not do for you: they're declared `optional`, so a missing one surfaces as
`MODULE_NOT_FOUND` at runtime, not at install.

| Plugin                         | Peer dependencies                                    |
| ------------------------------ | ---------------------------------------------------- |
| `llamacpp-completion`          | `@qvac/llm-llamacpp` + `@qvac/langdetect-text`       |
| `llamacpp-embedding`           | `@qvac/embed-llamacpp`                               |
| `whispercpp-transcription`     | `@qvac/asr-ggml`                                     |
| `parakeet-transcription`       | `@qvac/asr-ggml`                                     |
| `bci-whispercpp-transcription` | `@qvac/bci-whispercpp`                               |
| `nmtcpp-translation`           | `@qvac/translation-nmtcpp` + `@qvac/langdetect-text` |
| `tts-ggml`                     | `@qvac/tts-ggml`                                     |
| `sdcpp-generation`             | `@qvac/diffusion-cpp`                                |
| `ggml-ocr`                     | `@qvac/ocr-ggml`                                     |
| `ggml-classification`          | `@qvac/classification-ggml`                          |
| `ggml-vla`                     | `@qvac/vla-ggml`                                     |
| `audiogen-ggml`                | `@qvac/audiogen-ggml` + `@qvac/decoder-audio`        |

The second entries are transitive — a shared op file imports them — so they
aren't obvious from the plugin's own source. `langdetect-text` in particular is
required by completion even though nothing here translates anything.

Watch the version range: `@qvac/inference` pins peers like `^0.45.0`, and npm's
caret on a `0.x` version excludes `0.46`. Installing "latest" gives you a
version that doesn't satisfy the peer.

### System prompt, tools, structured output

All in `workers/qvac.js`'s `ask()`. `completion()` also takes `tools`,
`responseFormat` and `kvCache`; the UI already sends full history each turn, so
a system message is just an extra entry at the front.

If you add tools, note the answer stream gains `toolCall` events — decide in the
worker whether to execute and loop, or forward them for the UI to render.

### A different UI

Replace `ui/app.js` and `ui/transcript.js`. The protocol above is the entire
contract, and the tests show what a host has to handle. bare-tui's own
[CLAUDE.md][bare-tui-claude] is the reference for the widgets and the Elm loop.

## Testing

`test/index.js` drives the real model class with a fake inference client and
synthetic messages. Follow its shape:

- `fakeInference()` records `asked`/`cancelled` and returns an id — no worker,
  no model, no GPU.
- `drive(app, msgs)` folds messages and **runs returned Cmds** the way the
  Program would. Forgetting to run the Cmd is why an `ask` "doesn't happen".
- Assert on `style.stripAnsi(app.view())` for what's on screen.
- The last test drives a real `Program` with injected streams and `fps: 0` for
  deterministic frames — use it for anything lifecycle-shaped.

Two things worth a test whenever you touch them, because both have broken here:
**the view is exactly N rows** at several sizes, and **keys reach the component
you meant** — especially after adding anything that competes for `enter` or
`esc`.

The captured Program output is a diff stream, not a screen buffer: "this text
appeared" is reliable, "this text is gone" is not. Snapshot `view()` for
current-state assertions.

## Before you call it done

```sh
npm run lint    # prettier + lunte
npm test        # headless, no model needed
npm start       # the real thing
```

`npm test` passing does not prove the app runs — it never loads a model. Run
`npm start` at least once after touching `workers/qvac.js`, `lib/inference.js`
or `bin.mjs`, and confirm it **exits cleanly on ctrl+c** rather than hanging.

## Quick gotcha checklist

- Model not unloaded on shutdown → app hangs on exit, terminal never returns.
- `require('@qvac/inference')` in a CJS worker → won't resolve; use `await import`.
- Uncaught throw in a worker → uncatchable `Bare.exit(1)` over a painted TUI.
- New plugin without its (optional, transitive) peer dep → `MODULE_NOT_FOUND`.
- Peer installed as "latest" → outside the `^0.x` range the SDK pins.
- Hardcoded chrome height → view one row too tall, terminal scrolls, screen jumps.
- Empty banner string not filtered out of `view()` → a permanent blank row.
- Broadcasting keys to the update banner → `enter` applies an update instead of sending.
- Async result applied after interrupt → tokens from a cancelled run in the next answer.
- Non-serialisable value written to the pipe → silently dropped or a parse error.
- SDK imported into `ui/app.js` → the fast, GPU-free test suite is gone.
- Reporting "done" without checking `stopReason` → truncated answers look complete.
- Reasoning replayed as history → context fills up, later answers get cut short.
- New entry field that affects rendering, missing from `entryLines`'s signature → stale rows.

<!-- Reference Links -->

[bare-tui-claude]: https://github.com/holepunchto/bare-tui/blob/main/CLAUDE.md
[bare-tui-updater]: https://github.com/holepunchto/bare-tui-updater
[hello-pear-bare]: https://github.com/holepunchto/hello-pear-bare
