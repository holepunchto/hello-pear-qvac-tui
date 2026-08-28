# hello-pear-qvac-tui

> Pear Hello World for a local-AI CLI: [Bare] + [QVAC] on-device inference + a [bare-tui] interface, with peer-to-peer OTA updates.

An ask/answer terminal app where the model runs **on your machine** — no API key, no network round-trip, no cloud. It is a template: the plumbing is finished and commented, the app itself is deliberately small so you can replace it.

It is also built to be handed to an agent. Point yours at [CLAUDE.md](CLAUDE.md) and tell it what you want the app to do — that file carries the decisions, the extension points, and the traps this repo has already hit.

Three pieces, each doing the job it is best at:

- **[Bare]** — the runtime, plus [`pear-runtime`][pear-runtime] for peer-to-peer OTA updates and [`bare-build`][bare-build] for standalone binaries.
- **[QVAC]** — `@qvac/inference` loads a GGUF model and streams tokens, in-process, on the Bare runtime.
- **[bare-tui]** — the terminal UI, as an Elm-architecture model, with [bare-tui-updater] as the confirm gate for OTA updates.

```
╭──────────────────────────────────────────────────────────────────╮
│ ◆ hello-pear-qvac  v0.0.0-rc.0                                   │
│ model LLAMA_3_2_1B_INST_Q4_0   ready                             │
╰──────────────────────────────────────────────────────────────────╯
 LLAMA_3_2_1B_INST_Q4_0 loaded — ask it anything.

 ❯ Name one ocean. Answer in 3 words.

 Pacific Ocean

╭──────────────────────────────────────────────────────────────────╮
│ ❯ ask the model something…                                       │
╰──────────────────────────────────────────────────────────────────╯
  ↵ send · pgup/pgdn scroll · ctrl+c quit
```

## Table of Contents

- [OS Support](#os-support)
- [Requirements](#requirements)
- [Development](#development)
- [Architecture](#architecture)
  - [Two workers, one pattern](#two-workers-one-pattern)
  - [The inference protocol](#the-inference-protocol)
  - [The UI](#the-ui)
- [Making it yours](#making-it-yours)
- [Peer-to-Peer Deployments](#peer-to-peer-deployments)
- [Scripts](#scripts)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)

For guidance on modifying this template — yours or an agent's — see [CLAUDE.md](CLAUDE.md).

## OS Support

- **macOS** — arm64, x64
- **Linux** — arm64, x64
- **Windows** — arm64, x64

QVAC ships native prebuilds for each of these. GPU acceleration is picked up automatically where available (Vulkan, Metal); otherwise it runs on CPU.

## Requirements

- `npm` via [Node.js][nodejs]
- [Bare][bare] — `npm i -g bare-runtime`
- [pear][pear-docs] — `npx pear` (only needed to publish updates)
- ~1 GB of disk for the default model, fetched once on first run

## Development

```sh
npm install
npm start
```

The first run downloads the model — the TUI shows a progress bar while it does — and caches it, so later runs start in a couple of seconds. Then type a question and press enter.

| key           | does                                    |
| ------------- | --------------------------------------- |
| `↵`           | send                                    |
| `esc`         | interrupt the answer being generated    |
| `pgup`/`pgdn` | scroll the transcript (mouse wheel too) |
| `ctrl+c`      | interrupt if busy, otherwise quit       |

Pick a different model without touching code:

```sh
npm start -- --model LLAMA_3_2_3B_INST_Q4_0
```

Any model constant exported by `@qvac/inference` works; the default lives in `package.json` under `qvac.model`.

### Context window

```sh
npm start -- --ctx 16384
```

**The addon's default context is 1024 tokens** — small enough that a couple of turns of history leave no room to reply, and answers stop mid-sentence. This template sets `8192` (`qvac.ctxSize` in `package.json`). Everything the model holds at once lives in there: the conversation so far, its reasoning, and the answer it is writing. Raise it for long conversations, lower it to save memory.

If an answer does hit the limit, the app says so rather than pretending the model finished:

```
 ⚠ stopped at the 8192 token context limit — raise --ctx, or start a new question
```

### Thinking models

Reasoning models (`HEALTHCARE_4B_MEDICAL_Q8_0`, the Qwen3 family, …) emit a `<think>` block before answering. The app asks for `captureThinking`, so reasoning arrives as separate events instead of raw tags in the reply. It streams live while the model works, then collapses:

```
 ✻ thought for 2.4s · ctrl+t to show
 Common causes include poor sleep, anaemia, thyroid problems, and depression.
```

Reasoning is deliberately **not** replayed as history. It is per-turn scratch work, and sending it back is the fastest way to exhaust the context window — which is what makes the second and third answers truncate.

### Updates

OTA updates are off until you supply your own key: `package.json`'s `upgrade` field starts as the placeholder `pear://<YOUR_KEY_HERE>`, and the app skips the updater and says so in the transcript rather than crashing. Create a link with [`pear touch`](https://docs.pears.com/reference/cli.html#pear-touch-flags-channel), paste it into `upgrade`, then:

```sh
npm start -- --updates
```

When a new build finishes downloading, a banner appears at the bottom — and nothing else moves until you act on it:

```
╭──────────────────────────────────────────────────────────────────╮
│ ❯ ask the model something…                                       │
╰──────────────────────────────────────────────────────────────────╯
  ↵ send · pgup/pgdn scroll · ctrl+c quit
  ✓ Update v0.1.0 ready — press ctrl+r to update, esc to dismiss
```

`ctrl+r` applies it, `esc` dismisses. See [The update banner](#the-update-banner).

## Architecture

```
bin.mjs                    CLI parsing, and the one place the outside world
   │                       is wired to the UI
   ├── app.js ──────────── workers/main.js     OTA updates   (Bare thread)
   ├── lib/inference.js ── workers/qvac.js     @qvac/inference (Bare thread)
   └── ui/app.js                               bare-tui model + update banner
```

### Two workers, one pattern

Both workers are started with `PearRuntime.run(...)` and spoken to over a `FramedStream`. `lib/inference.js` is deliberately the same shape as `app.js` — a `ReadyResource` that owns an IPC pipe and turns frames into events — so learning one teaches you the other.

Inference gets its own thread for two reasons worth knowing before you restructure this:

1. **Loading a GGUF blocks the thread it runs on.** In-process, that stalls the event loop for seconds and the spinner visibly stutters. On its own thread the UI stays responsive. Generation itself is already async and never blocks.
2. **Crash isolation.** A native addon fault takes down its thread, not your terminal.

### The inference protocol

One JSON object per frame, `t` is the tag. `id` correlates an answer with the request that asked for it.

| direction | frame                          | meaning                           |
| --------- | ------------------------------ | --------------------------------- |
| →         | `{ t: 'ask', id, history }`    | answer this conversation          |
| →         | `{ t: 'cancel', id }`          | stop that answer                  |
| →         | `{ t: 'close' }`               | unload the model and shut down    |
| ←         | `{ t: 'progress', percentage}` | model download, 0–100             |
| ←         | `{ t: 'loaded', model }`       | resident and ready                |
| ←         | `{ t: 'delta', id, text }`     | a token                           |
| ←         | `{ t: 'end', id }`             | answer finished, or was cancelled |
| ←         | `{ t: 'error', id, message }`  | something went wrong              |
| ←         | `{ t: 'closed' }`              | safe to terminate the thread      |

Cancelling is precise: `completion()` exposes a `requestId` synchronously, so `esc` cancels exactly the one in-flight request rather than everything on the model.

The `close` handshake matters. A resident model holds native handles that keep the process alive — without unloading first, the app hangs at exit instead of quitting.

`stopReason` matters just as much. `run.events` ends **normally** when a completion fails or runs out of context, and `run.final` carries the reason — so a worker that only reads deltas reports a truncated answer as a clean finish. The worker awaits `final` and forwards the reason; the UI turns `length` into a visible warning.

### The UI

`ui/app.js` is a plain [bare-tui] model: state in the constructor, messages folded in `update()`, a pure `view()`. It never imports the QVAC SDK. Inference arrives as messages (`qvac.delta`, `qvac.end`, …) that `bin.mjs` forwards from the worker, and requests leave through Cmds.

That split is the point: the whole UI is testable with no model, no GPU and no terminal. `test/index.js` drives streaming, interruption, stale-result handling and layout in ~150 ms — see [bare-tui's CLAUDE.md][bare-tui-claude] for the patterns it follows.

### The update banner

Updates are **confirm-gated**. `app.js` stages a new build but deliberately does not apply it — swapping the binary out from under someone mid-conversation is not a good default. [bare-tui-updater] renders the prompt and `bin.mjs` connects the two:

```js
wire(ui.updater, { updater: app, send: program.send.bind(program) })
```

`wire()` expects a `pear-runtime` updater — an emitter of `updating` / `updated` / `error` with a `nextVersion`. `App` already is one, so it can be passed straight in, even though the real updater lives over in the worker thread. Accepting calls `app.applyUpdate()`, which resolves only once the worker confirms, so the banner can tell "applying…" from "restart to use it".

Two things are worth knowing if you restyle this:

- **The banner is chrome, and it is measured, not counted.** It occupies zero rows while idle and 1 or 3 when visible, depending on the installed version. `_bannerHeight()` measures what it actually renders and `_layout()` subtracts it, so the view stays exactly as tall as the terminal either way. In `view()`, the `.filter(Boolean)` is load-bearing — an empty string would still take a row.
- **Its default keys collide with this app.** bare-tui-updater accepts on `enter` as well as its accept key, and defaults that key to `u`. Here `enter` sends a question and `u` is an ordinary letter, so the banner is given `acceptKey: 'ctrl+r'` and only ever sees the two keys it owns — the rest is routed by the app first. `esc` interrupts an answer while busy and dismisses the banner otherwise. There are tests for all three.

> **Note:** `border: false` (a one-line banner instead of a box) needs a `bare-tui-updater` newer than the published `0.0.1`. The option is passed already and the layout measures the result, so the app picks up the single-line look the moment a newer version is installed — no code change.

## Making it yours

- **Different model** — `--model`, or `qvac.model` in `package.json`.
- **Different modality** — `workers/qvac.js` registers exactly one plugin. Swap `llamacpp-completion` for `whispercpp-transcription`, `llamacpp-embedding`, `tts-ggml`, `sdcpp-generation`, … and the peer dependency that backs it. Plugins are explicit in QVAC: nothing you don't register gets linked in.
- **Different UI** — replace `ui/app.js`. The protocol above is the whole contract.
- **A system prompt, tools, RAG** — `ask()` in `workers/qvac.js` takes the full history; `completion()` also accepts `tools`, `responseFormat` and `kvCache`.
- **Update behaviour** — `mode: 'silent'` in `ui/app.js` applies without asking; `'notify-only'` just narrates. Restarting after an apply is left to you on purpose — see [bare-tui-updater's README][bare-tui-updater] for the re-exec pattern.

## Peer-to-Peer Deployments

Set `upgrade` in `package.json` to your distribution drive link, then follow the default flow from section 4 onward:

[hello-pear-electron: 4. Build Deployment Directory and onward](https://github.com/holepunchto/hello-pear-electron#4-build-deployment-directory-)

Once the link is seeding, install the standalone peer-to-peer:

```sh
npx pear-install pear://<key>
```

## Scripts

- `npm start` — run in dev mode (`bare bin.mjs --no-updates`)
- `npm test` — headless `brittle-bare` tests, no model required
- `npm run lint` — prettier check and lunte
- `npm run format` — format with prettier
- `npm run make` — standalone for the current host into `out/make`
- `npm run make:<platform>-<arch>` — standalone for a specific target

Set `HOST` to override the target used by `npm run make`:

```sh
HOST=linux-arm64 npm run make
```

### Signing Standalones

`npm run make` supports the signing credentials provided by the [`make-pear-app` GitHub Action][make-pear-app]:

- On macOS, set `MAC_CODESIGN_IDENTITY` to sign with the hardened runtime. Set `KEYCHAIN_PROFILE` as well to submit to Apple's notary service.
- On Windows, set `WINDOWS_CERT_SHA1` to sign with the matching certificate from the current user's store.

## Project Structure

- `bin.mjs` — CLI entrypoint; wires workers to the UI
- `ui/app.js` — the bare-tui model (all the UI lives here), including the update banner
- `lib/inference.js` — client for the inference worker
- `workers/qvac.js` — loads the model, streams tokens
- `app.js` — client for the OTA updater worker; stages updates, applies on request
- `workers/main.js` — the OTA updater worker
- `scripts/make.js` — standalone builder with signing and notarization
- `test/index.js` — headless tests
- `CLAUDE.md` — how to extend this template, and the traps it already hit

## Troubleshooting

- **`ggml_vulkan: …` / `initFromConfig: …` printed over the UI.** llama.cpp writes these to stderr with `fprintf`, below any JS logger — the SDK's `logger` option and `modelConfig.verbosity` do not gate them, and Bare has no `dup2` to redirect the fd. `bin.mjs` repairs the screen with a full repaint once the model is loaded. Harmless.
- **First run seems stuck at 0%.** It is fetching ~1 GB. Progress updates as blocks arrive.
- **`INVALID_URL: Invalid URL 'pear://<YOUR_KEY_HERE>'`** means the updater ran with the placeholder key. Run `pear touch` and paste the link into `package.json`.
- **The app hangs on exit.** The model must be unloaded before the thread can go away — that is what the `close` handshake in `lib/inference.js` is for.
- **Answers stop mid-sentence, worse on the second or third reply.** The context window is full. Raise `--ctx`. The app flags this now, but if you have changed the worker, check `stopReason === 'length'`.
- **Raw `<think>` tags in the reply.** `captureThinking` isn't on for that call — see `ask()` in `workers/qvac.js`.
- **Out of memory / very slow.** Try a smaller quantisation or a smaller model via `--model`. Large models on an integrated GPU can run at a few tokens/second.
- **The update banner shows no version number.** `hello-pear-worker` doesn't forward `nextVersion` over the pipe, so `App.nextVersion` stays null and the banner omits it. Forward it from your own updater worker if you want it.
- **An update downloaded but nothing happened.** That is the confirm gate working — press `ctrl+r`. Applying does not restart the process; relaunch to run the new build.

<!-- Reference Links -->

[pear-docs]: https://docs.pears.com
[pear-runtime]: https://github.com/holepunchto/pear-runtime
[Bare]: https://github.com/holepunchto/bare
[bare]: https://github.com/holepunchto/bare
[bare-tui]: https://github.com/holepunchto/bare-tui
[bare-tui-updater]: https://github.com/holepunchto/bare-tui-updater
[bare-tui-claude]: https://github.com/holepunchto/bare-tui/blob/main/CLAUDE.md
[QVAC]: https://qvac.tether.io
[nodejs]: https://nodejs.org
[bare-build]: https://github.com/holepunchto/bare-build
[make-pear-app]: https://github.com/holepunchto/actions/tree/main/make-pear-app
