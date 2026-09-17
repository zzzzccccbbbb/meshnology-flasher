# Meshnology Web Flasher

A 100% client-side, open-source firmware flashing tool for the **ESP32 family** via **Web Serial**. No login, no cloud, no telemetry. The browser talks to your board directly through [esptool-js](https://github.com/espressif/esptool-js).

> **Status: v0.2 preview.** Real flashing works for the entire ESP32 family (ESP32, S2, S3, C2, C3, C5, C6, C61, H2, P4, ESP8266). Tested host-side, **end-to-end hardware testing required before v0.2 GA**.

## Supported chips

| Family | Chip | Notes |
|---|---|---|
| Original | ESP32 | |
| | ESP32-S2 | |
| | ESP32-S3 | USB-OTG native or via CH340/CP210x |
| | ESP8266 | |
| RISC-V | ESP32-C2 | |
| | ESP32-C3 | |
| | ESP32-C5 | |
| | ESP32-C6 | |
| | ESP32-C61 | |
| | ESP32-H2 | |
| | ESP32-P4 | |

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173
# or
npm run build && npm run preview
```

Web Serial requires a **secure context** (HTTPS or `http://localhost`). Use **Chrome 89+** or **Edge 89+**. Firefox and Safari don't support Web Serial.

## Use

1. Connect your board via USB. **CH340 / CP210x / FTDI / ESP32-S3 native USB** all work.
2. Open `http://localhost:5173/` and click **Choose serial port**.
3. Drop a single `.bin` (or use multi-file mode with explicit offsets).
4. (Optional) adjust flash parameters (mode / frequency / size) — defaults are safe for most boards.
5. Click **Start flashing** — esptool.js will sync, detect the chip, erase, write, verify, and restart.

The browser will show a live terminal with esptool.js stdout, real progress (in bytes), and the detected chip name. Firmware never leaves the browser.

## Hardware notes

- **ESP32-S3-DevKitC** (with USB-OTG / native USB): plug directly into the PC. The web flasher sees VID `0x303A` / PID `0x1001`.
- **ESP32 / ESP32-S2 with CH340**: VID `0x1A86`, VID `0x10C4` (CP210x), or `0x0403` (FTDI).
- If the board doesn't appear in the device picker, hold the **BOOT** button while plugging it in (forces bootloader mode).

## Errors & troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser says Web Serial unsupported | Firefox / Safari | Use Chrome 89+ or Edge 89+ |
| "Cannot open port" | Another serial monitor has the port | Close Arduino IDE Serial Monitor / PuTTY / minicom |
| "ROM sync failed" | Wrong port, or board not in bootloader | Hold BOOT and replug; ensure correct USB-UART bridge |
| "Unknown chip" | Esptool can't identify the device | Try `default_reset` mode; check board is not mid-flash |
| Flash hangs at "Erasing" | Flash size mismatch | Set Flash size manually instead of `auto` |
| Terminal shows red `Guru Meditation` | Firmware crashed the chip | Power cycle, retry |

## Development

```bash
npm run dev          # vite dev server with HMR
npm run build        # production build to dist/
npm run preview      # serve dist/ locally
npm test             # vitest, 41 tests
```

### Architecture (v0.2)

```
src/
  main.ts                     # UI entry, three-step cards
  flasher.ts                  # segment validation (file size, alignment, overlaps)
  esp32/
    chipDetect.ts             # ROM name → friendly code (11 chips)
    flashConfig.ts            # UI strings → esptool.js typed literals
    flasher.ts                # flashEsp32(port, files, cfg, callbacks) — top-level orchestration
docs/
  v0.2-plan.md                # architecture & decision record
  v0.2-plan-v1.md             # abandoned: self-written SLIP stack (kept for reference)
```

## License

MIT. Built on [esptool-js](https://github.com/espressif/esptool-js) (Apache 2.0 / Espressif).