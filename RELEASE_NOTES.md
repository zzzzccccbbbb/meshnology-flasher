# Release Notes — v0.2.0 (preview)

> Web-based firmware flashing tool for the **ESP32 family** via Web Serial.
> Powered by [esptool-js](https://github.com/espressif/esptool-js) (Apache-2.0, Espressif).

## TL;DR

A 100% client-side, open-source flashing tool. The browser talks to the board
directly through Web Serial. No server, no cloud, no telemetry, no accounts.
Single `.bin` dropped into the page is written to the chip.

## What's working

- **11 ESP chips supported** (auto-detected by esptool-js):
  - ESP32, ESP32-S2, **ESP32-S3**, ESP8266
  - ESP32-C2 / C3 / C5 / C6 / C61 / H2 / P4
- **Transport**: Web Serial over USB-UART bridges (CH340, CP210x, FTDI) and
  ESP32-S3 native USB-OTG (PID `0x1001`)
- **Flash parameters** with safe defaults (mode / frequency / size are user-
  adjustable; `auto` lets esptool-js pick from chip-reported values)
- **Live terminal** showing esptool-js stdout via XTerm.js
- **Real-time progress** in bytes (not a fake animation)
- **i18n**: English + Simplified Chinese
- **Mobile-friendly** layout (progress bar pins to viewport bottom during flash)
- **Error reporting** in user's UI language for all 11 known failure modes

## End-to-end verified

| | |
|---|---|
| **Board** | w20-meshnology ESP32-S3 DevKit (USB-OTG, VID `0x303A`, PID `0x1001`) |
| **Browser** | Chrome / Edge ≥ 89 (Web Serial) |
| **Firmware** | 1.25 MB merged `.bin` |
| **Result** | 1310112 bytes (778381 compressed) written at `0x0` in 11.25 s |
| **After** | Board hard-reset via RTS, rebooted into new firmware |

## Tech stack

| Layer | Choice |
|---|---|
| UI | Vanilla TS + Vite 6 (no framework) |
| Terminal | `@xterm/xterm` + `@xterm/addon-fit` |
| Flashing | `esptool-js` 0.6.1 (Espressif's official port of esptool.py) |
| Tests | `vitest` 2.1, 41 tests covering chip detection + flash config mapping |
| Build output | 462 KB raw / 126 KB gzip; per-chip code split into 24 dynamic-import chunks |

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
# or
npm run build && npm run preview
```

Web Serial requires **HTTPS or `localhost`**. Use **Chrome ≥ 89** or **Edge ≥ 89**.
Firefox and Safari don't support Web Serial.

## Use it

1. Plug your board via USB
2. Open `http://localhost:5173/` → click **Choose serial port**
3. Drop a single `.bin` (or use multi-file mode with explicit offsets)
4. (Optional) adjust flash parameters — defaults are safe for most boards
5. Click **Start flashing** — chip detect, erase, write, verify, restart
   all run automatically

If the board doesn't appear in the device picker, hold **BOOT** while plugging
in (forces bootloader mode).

## What's NOT in v0.2

These are intentionally out of scope. Add them when there's demand:

- ❌ **nRF52 / non-ESP chips** — Esptool only
- ❌ **Cloud firmware catalog** — local upload only; backend not implemented
- ❌ **Account / login / billing** — 100 % client-side; nothing to log in to
- ❌ **Flash encryption / Secure Boot v2** — dev builds only
- ❌ **Custom stub loader** — uses esptool-js's bundled RAM stub; max flash freq
  is 40 MHz (S3 actually supports 80 MHz but it requires a custom stub)
- ❌ **OTA partition switching** — single-shot firmware replacement only
- ❌ **iOS / mobile Safari** — Web Serial is desktop-only

## Integration notes for the website team

- **License**: MIT. Esptool-js is Apache-2.0; both are commercially compatible.
- **Bundle size**: 126 KB gzip on initial load; per-chip code (1.5–8 KB) loads
  on demand when the user picks a chip.
- **CDN / static hosting**: works on Cloudflare Pages, Vercel, Netlify, GitHub
  Pages, S3 + CloudFront — anywhere that serves HTTPS with a `Content-Type`
  that lets the browser treat the SPA as an app.
- **CSP**: requires `connect-src 'self'` and `script-src 'self' 'wasm-unsafe-eval'`
  (esptool-js uses WebAssembly for crypto helpers).
- **No backend needed**: everything runs in the user's browser.
- **No telemetry**: there are zero analytics or third-party requests.
- **Browser support matrix** matches Web Serial availability — Chrome/Edge 89+
  desktop. Add an "unsupported browser" notice for Firefox/Safari users.

## Known limitations

- **WebUSB fallback not implemented**. We use Web Serial only. Some boards
  expose themselves as raw USB (not CDC-ACM); users on those boards will need
  Chrome with the `--enable-experimental-web-platform-features` flag, or you
  can add a WebUSB path in v0.3.
- **MD5 whole-image verify is skipped** because esptool.js's
  `calculateMD5Hash` callback is synchronous, but SubtleCrypto.digest (the
  only browser-side MD5 API) is async. Per-block checksums with retries are
  still active inside esptool-js, so corruption is detected and re-written,
  but a final compare-against-original is not done.
- **One flash at a time**: the UI allows multi-file mode but v0.2 always
  writes the first segment at offset 0 and ignores later offsets. Add per-
  segment address support in v0.3 if needed.

## Files of interest

```
src/
  main.ts                     UI entry, three-step cards, XTerm container
  flasher.ts                  segment validation
  esp32/
    chipDetect.ts             ROM name → 11-chip friendly code
    flashConfig.ts            UI strings → esptool.js typed literals
    flasher.ts                top-level flash orchestration
    *.test.ts                 33 test cases (vitest)
docs/
  v0.2-plan.md                architecture, error matrix, design decisions
  v0.2-plan-v1.md             abandoned self-written SLIP stack proposal
README.md                     user-facing docs
```

## Support

- **Issues**: file on GitHub at `zzzzccccbbbb/meshnology-web-flasher`
- **Board not detected**: most common cause is the board not being in
  bootloader. Hold BOOT and replug.
- **For chips other than ESP32-S3**: smoke-test on a real board before
  shipping. Esptool-js covers 11 chips but only ESP32-S3 has been end-to-end
  tested with this UI as of v0.2.0.

---

Released: Thu Sep 17 2026 · Branch: `main` · Commit: `231e633`