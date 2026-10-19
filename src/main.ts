import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { validateSegments, type FirmwareSegment } from './flasher';
import { STRINGS, type Lang } from './i18n';
import { flashEsp32, type FlashFile, type Phase } from './esp32/flasher';
import { describeUiConfig } from './esp32/flashConfig';
import type { ChipCode } from './esp32/chipDetect';
import { fetchManifest, fetchDevice, CatalogError } from './catalog/api';
import { downloadFirmware } from './catalog/reader';
import type { DeviceDetails, FirmwareVersion } from './catalog/types';

/* ---------------------------------------------------------------- *
 *  Types & state
 * ---------------------------------------------------------------- */

type Segment = FirmwareSegment & { file?: File };

interface FlashConfig {
  mode: string;   // 'auto' | 'QIO' | 'QOUT' | 'DIO' | 'DOUT'
  freq: string;   // 'auto' | '40m' | '80m'
  size: string;   // 'auto' | '1mb' | '2mb' | '4mb' | '8mb' | '16mb'
}

const app = document.querySelector<HTMLDivElement>('#app')!;

let segments: Segment[] = [];
let lang: Lang = (localStorage.getItem('meshnology-lang') as Lang) || 'en';

let serialPort: SerialPort | null = null;
let portInfo: { usbVendorId?: number; usbProductId?: number } | null = null;

// v0.3: defaults changed from "auto/auto/auto" to "DIO/80m/16mb".
// In v0.2 the auto-detect path would silently skip writing on some
// boards (chip ID read worked, but SPI flash param read came back
// empty, so the write failed before reporting). Picking safe ESP32-S3
// values matches the esptool.py `flash_args` file that ESP-IDF
// produces for these chips, and removes the silent-failure mode.
// Users on chips that need a different setting (QIO, 40m, 8mb) can
// still override the dropdown.
let flashConfig: FlashConfig = { mode: 'DIO', freq: '80m', size: '16mb' };

/**
 * v0.3 source mode:
 *   'upload'  — user picks a .bin from disk (default when no URL params)
 *   'catalog' — firmware comes from the prebuilt static catalog
 * Either way, the Start flashing handler builds a FlashFile[] and
 * hands it to flashEsp32 — the protocol layer doesn't care.
 */
type SourceMode = 'upload' | 'catalog';
let sourceMode: SourceMode = 'upload';

interface Preselected {
  deviceId: string | null;
  version: string | null;
}
const urlParams: Preselected = parseUrlParams();

/** In catalog mode, the bytes are fetched from R2 (well, Pages static)
 *  just before Start flashing, then verified by SHA-256. */
let catalogFirmware: { deviceId: string; version: FirmwareVersion } | null = null;

function parseUrlParams(): Preselected {
  const sp = new URLSearchParams(window.location.search);
  const deviceId = sp.get('device');
  const version = sp.get('version');
  return {
    deviceId: deviceId && /^[a-z0-9][a-z0-9-]{0,40}$/.test(deviceId) ? deviceId : null,
    version: version && /^\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$/.test(version) ? version : null,
  };
}

let term: Terminal | null = null;
let termFit: FitAddon | null = null;
let lastProgressText = ''; // (unused; kept for backward compatibility)

const t = () => STRINGS[lang];

/* ---------------------------------------------------------------- *
 *  Vendor ID → friendly name
 * ---------------------------------------------------------------- */

const VENDOR_NAMES: Record<number, string> = {
  0x1a86: 'CH340',
  0x10c4: 'CP210x',
  0x0403: 'FTDI',
  0x303a: 'Espressif',
  0x067b: 'Prolific',
  0x2341: 'Arduino',
  0x2e8a: 'Raspberry Pi',
};

function vendorName(vid?: number): string {
  if (vid === undefined) return 'USB Serial';
  return VENDOR_NAMES[vid] ?? `0x${vid.toString(16).padStart(4, '0').toUpperCase()}`;
}

/* ---------------------------------------------------------------- *
 *  Render shell HTML
 * ---------------------------------------------------------------- */

app.innerHTML = `
  <div class="shell">
    <header>
      <a class="brand" href="#" aria-label="Meshnology home">
        <img src="/logo.svg" alt="Meshnology" width="180" height="38" />
      </a>
      <nav>
        <a href="#docs" id="navDocs">${t().navDocs}</a>
        <div class="lang-switch" role="tablist" aria-label="Language">
          <button data-lang="en" class="lang-btn${lang === 'en' ? ' active' : ''}" aria-selected="${lang === 'en'}">EN</button>
          <span class="lang-sep">|</span>
          <button data-lang="zh" class="lang-btn${lang === 'zh' ? ' active' : ''}" aria-selected="${lang === 'zh'}">中</button>
        </div>
      </nav>
    </header>

    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">${t().eyebrow}</p>
          <h1>${t().heroTitle1}<br><em>${t().heroTitle2}</em></h1>
          <p class="lead">${t().lead}</p>
          <div class="cta-row">
            <button class="btn primary" id="cta-connect">${t().ctaConnect} →</button>
            <a class="btn ghost" href="#step-1" id="ctaHow">${t().ctaHow}</a>
          </div>
          <ul class="badges">
            <li>● ${t().badges[0]}</li>
            <li>● ${t().badges[1]}</li>
            <li>● ${t().badges[2]}</li>
          </ul>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="orb"><span>LOCAL<br/>ONLY</span></div>
        </div>
      </section>

      <section class="steps-grid">
        <!-- Step 01: Connect -->
        <div class="card" id="step-1">
          <div class="card-head">
            <span class="step">${t().step1Label}</span>
            <h2>${t().step1Title}</h2>
            <span id="serialStatus" class="badge idle">${t().step1StatusDisc}</span>
          </div>
          <p>${t().step1Desc}</p>
          <button id="serialConnect" class="btn primary full">${t().step1Btn} <span>→</span></button>
          <div id="serialInfo" class="serial-info hidden"></div>
          <small id="serialLog" style="display:block;margin-top:10px;color:var(--text-faint);font:11px ui-monospace,monospace">${t().step1LogChoose}</small>
        </div>

        <!-- Step 02: Firmware + config -->
        <div class="card">
          <div class="card-head">
            <span class="step">${t().step2Label}</span>
            <h2>${t().step2Title}</h2>
          </div>
          <p id="step2Desc">${t().step2DescUpload}</p>
          <div id="catalogSection" class="catalog-section hidden">
            <div class="catalog-grid">
              <div class="config-field">
                <label id="catalogDeviceLabel">${t().catalogDeviceLabel}</label>
                <select id="catalogDevice"></select>
              </div>
              <div class="config-field">
                <label id="catalogVersionLabel">${t().catalogVersionLabel}</label>
                <select id="catalogVersion"></select>
              </div>
            </div>
            <p class="config-hint" id="catalogHint"></p>
          </div>
          <div id="drop" class="drop">
            <div class="upload-icon">↑</div>
            <b id="dropTitle">${t().dropTitle}</b>
            <span>${lang === 'zh' ? '或' : 'or'} <label for="fileInput">${t().dropBrowse}</label></span>
            <input id="fileInput" type="file" accept=".bin,application/octet-stream" multiple hidden />
          </div>
          <button id="browseCatalogBtn" class="btn ghost full" style="margin-top:10px">${t().browseCatalog}</button>
          <div id="segments" class="segments"></div>

          <div class="config-block">
            <div class="config-title">
              <span>${t().configTitle}</span>
            </div>
            <p class="config-hint">${t().configHint}</p>
            <div class="config-grid">
              <div class="config-field">
                <label for="cfgMode">${t().configMode}</label>
                <select id="cfgMode">
                  <option value="auto">${t().configAuto}</option>
                  <option value="QIO">QIO</option>
                  <option value="QOUT">QOUT</option>
                  <option value="DIO">DIO</option>
                  <option value="DOUT">DOUT</option>
                </select>
              </div>
              <div class="config-field">
                <label for="cfgFreq">${t().configFreq}</label>
                <select id="cfgFreq">
                  <option value="auto">${t().configAuto}</option>
                  <option value="40m">40 MHz</option>
                  <option value="80m">80 MHz</option>
                </select>
              </div>
              <div class="config-field">
                <label for="cfgSize">${t().configSize}</label>
                <select id="cfgSize">
                  <option value="auto">${t().configAuto}</option>
                  <option value="1mb">1 MB</option>
                  <option value="2mb">2 MB</option>
                  <option value="4mb">4 MB</option>
                  <option value="8mb">8 MB</option>
                  <option value="16mb">16 MB</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <!-- Step 03: Flash + terminal -->
        <div class="card step-card-full flash-card" id="step-3">
          <div class="card-head">
            <span class="step">${t().step3Label}</span>
            <h2>${t().step3Title}</h2>
          </div>
          <p>${t().step3Desc}</p>
          <div class="flash-meta" id="flashMeta">
            <span><span class="meta-key">${t().chipLabel}:</span><span class="meta-value" id="chipValue">${t().chipUnknown}</span></span>
          </div>
          <div class="flash-row">
            <div class="flash-info">
              <p class="summary" id="summary">${t().progressEmpty}</p>
              <div class="progress"><i id="bar"></i></div>
              <div class="progress-meta">
                <span id="log">${t().progressIdle}</span>
                <span id="progressBytes">0 B / 0 B</span>
              </div>
            </div>
            <div class="flash-actions">
              <button id="flashBtn" class="btn dark" disabled>${t().flashBtn} <span>→</span></button>
              <button id="abortBtn" class="btn danger hidden">${t().abortBtn}</button>
            </div>
          </div>

          <div class="terminal-section">
            <div class="terminal-head">
              <span class="label">${t().terminalLabel}</span>
            </div>
            <div class="terminal-container" id="termContainer">
              <div class="terminal-empty" id="termEmpty">${t().terminalEmpty}</div>
            </div>
          </div>
        </div>
      </section>

      <div class="notice" id="notice">
        ⚠ <span>${t().step1LogBoot}</span>
      </div>
    </main>

    <footer id="docs">
      <span id="footer1">${t().footer1}</span>
      <span id="footer2">${t().footer2}</span>
    </footer>
  </div>
`;

/* ---------------------------------------------------------------- *
 *  DOM refs (queried after innerHTML)
 * ---------------------------------------------------------------- */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

const mainEl = $('main');

const serialStatus = $('#serialStatus');
const serialConnectBtn = $<HTMLButtonElement>('#serialConnect');
const serialInfo = $('#serialInfo');
const serialLog = $('#serialLog');

const drop = $('#drop');
const fileInput = $<HTMLInputElement>('#fileInput');
const list = $('#segments');
const summaryEl = $('#summary');
const bar = $('#bar');
const logEl = $('#log');
const progressBytes = $('#progressBytes');
const flashBtn = $<HTMLButtonElement>('#flashBtn');
const abortBtn = $<HTMLButtonElement>('#abortBtn');
const chipValue = $('#chipValue');

const cfgMode = $<HTMLSelectElement>('#cfgMode');
const cfgFreq = $<HTMLSelectElement>('#cfgFreq');
const cfgSize = $<HTMLSelectElement>('#cfgSize');

const termContainer = $('#termContainer');
const termEmpty = $('#termEmpty');

const cta = $<HTMLButtonElement>('#cta-connect');

/* ---------------------------------------------------------------- *
 *  Helpers
 * ---------------------------------------------------------------- */

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function browserSupportsSerial(): boolean {
  return 'serial' in navigator;
}

/**
 * Map a flash error kind + raw esptool message into a short, user-facing
 * i18n string. Falls back to the raw message when the kind is unknown.
 */
function errorToFriendly(kind: string, msg: string, T: ReturnType<typeof t>): string {
  switch (kind) {
    case 'SERIAL_OPEN_FAIL':  return T.errBrowserUnsupported;
    case 'PORT_ALREADY_OPEN': return T.errPortAlreadyOpen;
    case 'SYNC_TIMEOUT':      return T.errSyncTimeout;
    case 'CHIP_UNKNOWN':      return T.errChipUnknown;
    case 'ERASE_FAIL':        return T.errErase;
    case 'WRITE_FAIL':        return T.errWrite;
    case 'VERIFY_FAIL':       return T.errVerify;
    case 'PORT_DISCONNECT':   return T.errPortDisconnect;
    case 'ABORTED':           return T.errAborted;
    default:                  return msg;
  }
}

function friendlyCatalogError(e: CatalogError, T: ReturnType<typeof t>): string {
  switch (e.kind) {
    case 'DEVICE_INVALID':     return T.errCatalogInvalid;
    case 'SCHEMA_MISMATCH':    return T.errCatalogLoad;
    case 'PARSE_FAILED':       return T.errCatalogLoad;
    case 'FETCH_FAILED':       return T.errCatalogLoad;
    case 'BIN_MISSING':        return T.errBinMissing;
    case 'BIN_SIZE_MISMATCH':  return T.errBinSizeMismatch;
    case 'FIRMWARE_CORRUPTED': return T.errFirmwareCorrupted;
    case 'CATALOG_INVALID':    return T.errCatalogInvalid;
    case 'SUBTLE_UNAVAILABLE': return T.errCatalogLoad;
    default:                   return e.message;
  }
}

/* ---------------------------------------------------------------- *
 *  Terminal bootstrap (XTerm, read-only)
 * ---------------------------------------------------------------- */

function ensureTerminal(): Terminal {
  if (term) return term;
  term = new Terminal({
    convertEol: true,
    disableStdin: true,
    cursorBlink: false,
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: {
      background: '#0f1a17',
      foreground: '#d4e0d9',
      cursor: '#d4e0d9',
      selectionBackground: '#264f43',
    },
    scrollback: 1000,
  });
  termFit = new FitAddon();
  term.loadAddon(termFit);
  term.open(termContainer);
  // Hide placeholder, fit on next frame
  if (termEmpty.parentElement) termEmpty.style.display = 'none';
  requestAnimationFrame(() => {
    try { termFit?.fit(); } catch { /* ignore */ }
  });
  return term;
}

function termWrite(line: string) {
  const tn = ensureTerminal();
  // ensure trailing newline so each call is its own line
  tn.writeln(line.endsWith('\n') ? line : line);
}

/* ---------------------------------------------------------------- *
 *  File segments (kept from v0.1)
 * ---------------------------------------------------------------- */

function renderSegments() {
  const T = t();
  list.innerHTML = segments.map((s, i) => `
    <div class="file-row">
      <span class="file-icon">▣</span>
      <div>
        <b>${s.name}</b>
        <small>${formatBytes(s.size)}</small>
      </div>
      <button data-remove="${i}" aria-label="${T.removeAria}">×</button>
    </div>
  `).join('');

  list.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => {
    b.onclick = () => {
      segments.splice(Number(b.dataset.remove), 1);
      renderSegments();
    };
  });
  list.querySelectorAll<HTMLInputElement>('[data-offset]').forEach(input => {
    input.onchange = () => {
      const i = Number(input.dataset.offset);
      segments[i].offset = parseInt(input.value, 16) || 0;
      renderSegments();
    };
  });

  if (segments.length) {
    const total = segments.reduce((n, s) => n + s.size, 0);
    summaryEl.textContent = `${T.filesCount(segments.length)} · ${formatBytes(total)}`;
    summaryEl.classList.remove('error');
  } else {
    summaryEl.textContent = T.progressEmpty;
    summaryEl.classList.remove('error');
  }
  updateFlashBtnState();
}

async function addFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    if (!file.name.toLowerCase().endsWith('.bin')) continue;
    segments.push({ name: file.name, size: file.size, offset: 0, file });
  }
  renderSegments();
}

fileInput.addEventListener('change', e => addFiles((e.target as HTMLInputElement).files || []));
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => {
  const de = e as DragEvent;
  de.preventDefault();
  drop.classList.remove('drag');
  if (de.dataTransfer) addFiles(de.dataTransfer.files);
});

// (single/multi tabs removed in v0.3 — catalog mode replaces multi)

/* ---------------------------------------------------------------- *
 *  Serial port (Web Serial, NO esptool yet — just open/close)
 * ---------------------------------------------------------------- */

async function doSerialConnect() {
  const T = t();
  if (!browserSupportsSerial()) {
    serialStatus.textContent = T.step1StatusUnsup;
    serialStatus.className = 'badge error';
    serialLog.innerHTML = T.errBrowserUnsupported;
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    serialPort = port;
    const info = port.getInfo();
    portInfo = info;
    const vendor = vendorName(info.usbVendorId);
    serialStatus.textContent = T.step1StatusConn;
    serialStatus.className = 'badge ok';
    serialInfo.textContent = `${vendor}${info.usbProductId ? ' · PID 0x' + info.usbProductId.toString(16).padStart(4, '0').toUpperCase() : ''}`;
    serialInfo.classList.remove('hidden');
    serialLog.innerHTML = T.step1LogGranted + vendor;

    termWrite(`[serial] opened ${vendor} (VID 0x${(info.usbVendorId ?? 0).toString(16).padStart(4, '0').toUpperCase()})`);
    termWrite('[serial] (esptool.js integration coming in Stage 2)');

    updateFlashBtnState();
  } catch {
    serialLog.innerHTML = T.step1LogCancelled;
  }
}

async function doSerialDisconnect() {
  if (serialPort) {
    try { await serialPort.close(); } catch { /* ignore */ }
    serialPort = null;
    portInfo = null;
  }
  serialStatus.textContent = t().step1StatusDisc;
  serialStatus.className = 'badge idle';
  serialInfo.classList.add('hidden');
  serialLog.textContent = t().step1LogChoose;
  termWrite('[serial] closed');
  updateFlashBtnState();
}

serialConnectBtn.addEventListener('click', async () => {
  if (serialPort) await doSerialDisconnect();
  else await doSerialConnect();
});

cta.addEventListener('click', () => {
  document.querySelector('#step-1')?.scrollIntoView({ behavior: 'smooth' });
  if (!serialPort) doSerialConnect();
});

/* ---------------------------------------------------------------- *
 *  FlashConfig wiring
 * ---------------------------------------------------------------- */

cfgMode.onchange = () => { flashConfig.mode = cfgMode.value; };
cfgFreq.onchange = () => { flashConfig.freq = cfgFreq.value; };
cfgSize.onchange = () => { flashConfig.size = cfgSize.value; };

/* ---------------------------------------------------------------- *
 *  Flash button gating + click handler (Stage 1: still fake animation)
 * ---------------------------------------------------------------- */

function updateFlashBtnState() {
  // Button enable depends on the current source mode:
  //   upload  — at least one .bin segment + a serial port
  //   catalog — a preselected firmware (from URL or dropdown) + a serial port
  // In both cases, no port = no flash.
  const hasPort = !!serialPort;
  if (sourceMode === 'catalog') {
    flashBtn.disabled = !(hasPort && catalogFirmware !== null);
  } else {
    flashBtn.disabled = !(hasPort && segments.length > 0);
  }
}

flashBtn.addEventListener('click', async () => {
  const T = t();
  if (!serialPort) {
    summaryEl.textContent = T.errNoPort;
    summaryEl.classList.add('error');
    return;
  }
  // Stage 2: real flash via esptool.js
  flashBtn.disabled = true;
  abortBtn.classList.remove('hidden');
  abortBtn.disabled = false;
  bar.style.width = '0%';
  summaryEl.classList.remove('error');
  // narrow viewport: pin progress + buttons to viewport bottom while flashing
  mainEl.classList.add('is-flashing');

  ensureTerminal();

  // Phase label helpers (i18n keys per Phase)
  const phaseLabel = (p: Phase): string => {
    switch (p) {
      case 'connecting': return T.progressConnecting;
      case 'syncing':    return T.progressSyncing;
      case 'detecting':  return T.progressDetecting;
      case 'erasing':    return T.progressErasing;
      case 'writing':    return T.progressWriting;
      case 'verifying':  return T.progressVerifying;
      case 'restarting': return T.progressRestarting;
      case 'done':       return T.progressDone;
    }
  };

  // Resolve firmware bytes based on the active source mode.
  //   upload  : user-provided File objects in `segments`
  //   catalog : download from /firmware/{id}/{version}.bin and verify SHA-256
  let files: FlashFile[];
  try {
    if (sourceMode === 'upload') {
      if (!segments.length) {
        summaryEl.textContent = T.errNoFirmware;
        summaryEl.classList.add('error');
        flashBtn.disabled = false;
        abortBtn.classList.add('hidden');
        mainEl.classList.remove('is-flashing');
        return;
      }
      const segErrs = validateSegments(segments);
      if (segErrs.length) {
        summaryEl.textContent = segErrs.join(' · ');
        summaryEl.classList.add('error');
        flashBtn.disabled = false;
        abortBtn.classList.add('hidden');
        mainEl.classList.remove('is-flashing');
        return;
      }
      files = await Promise.all(
        segments.map(async (s) => ({
          name: s.name,
          bytes: s.file ? new Uint8Array(await s.file.arrayBuffer()) : new Uint8Array(),
          offset: s.offset,
        })),
      );
    } else {
      if (!catalogFirmware) {
        summaryEl.textContent = T.errNoFirmware;
        summaryEl.classList.add('error');
        flashBtn.disabled = false;
        abortBtn.classList.add('hidden');
        mainEl.classList.remove('is-flashing');
        return;
      }
      const sizeMB = T.formatMb(catalogFirmware.version.size);
      logEl.textContent = T.progressFetching(sizeMB);
      termWrite(`[ui] fetching ${catalogFirmware.deviceId} ${catalogFirmware.version.version} (${sizeMB})…`);
      let downloaded;
      try {
        downloaded = await downloadFirmware(catalogFirmware.deviceId, catalogFirmware.version);
      } catch (e) {
        const msg = e instanceof CatalogError ? friendlyCatalogError(e, T) : (e as Error).message;
        summaryEl.textContent = msg;
        summaryEl.classList.add('error');
        termWrite(`! ${msg}`);
        flashBtn.disabled = false;
        abortBtn.classList.add('hidden');
        mainEl.classList.remove('is-flashing');
        return;
      }
      termWrite(`[ui] sha-256 verified for ${downloaded.version.filename}`);
      files = [{
        name: downloaded.version.filename,
        bytes: downloaded.bytes,
        offset: 0,
      }];
    }
  } catch (e) {
    summaryEl.textContent = (e as Error).message ?? String(e);
    summaryEl.classList.add('error');
    flashBtn.disabled = false;
    abortBtn.classList.add('hidden');
    mainEl.classList.remove('is-flashing');
    return;
  }

  const total = files.reduce((n, f) => n + f.bytes.byteLength, 0);
  progressBytes.textContent = `${formatBytes(0)} / ${formatBytes(total)}`;
  logEl.textContent = T.progressConnecting;
  termWrite(`[ui] starting flash — files=${files.length}, total=${formatBytes(total)}, ${describeUiConfig(flashConfig)}`);

  let lastPhase: Phase = 'connecting';
  try {
    await flashEsp32(
      serialPort,
      files,
      flashConfig,
      {
        onPhase: (p, detail) => {
          if (p !== lastPhase) {
            lastPhase = p;
            logEl.textContent = phaseLabel(p);
            if (p === 'done') termWrite(`> ${T.progressDone}`);
          }
          if (detail) termWrite(`> ${detail}`);
        },
        onProgress: (written, totalBytes) => {
          const pct = totalBytes > 0 ? Math.floor((written / totalBytes) * 100) : 0;
          bar.style.width = `${pct}%`;
          progressBytes.textContent = `${formatBytes(written)} / ${formatBytes(totalBytes)}`;
        },
        onLog: (line) => termWrite(line),
        onChip: (code: ChipCode, name: string) => {
          chipValue.textContent = `${name} (${code})`;
        },
        onError: (kind, msg) => {
          const friendly = errorToFriendly(kind, msg, T);
          summaryEl.textContent = friendly;
          summaryEl.classList.add('error');
          termWrite(`! ${friendly}`);
        },
      },
    );
    summaryEl.textContent = T.progressDone;
  } catch (e) {
    // flashEsp32 already called onError; reflect in summary
    if (!summaryEl.classList.contains('error')) {
      summaryEl.textContent = String((e as Error).message ?? e);
      summaryEl.classList.add('error');
    }
  }

  flashBtn.disabled = false;
  abortBtn.classList.add('hidden');
  mainEl.classList.remove('is-flashing');
});

abortBtn.addEventListener('click', () => {
  flashBtn.disabled = false;
  abortBtn.classList.add('hidden');
  mainEl.classList.remove('is-flashing');
  bar.style.width = '0%';
  logEl.textContent = t().progressCancelled;
  termWrite(`> ${t().progressCancelled}`);
});

/* ---------------------------------------------------------------- *
 *  Language switcher
 * ---------------------------------------------------------------- */

function applyLanguage(next: Lang) {
  lang = next;
  localStorage.setItem('meshnology-lang', next);
  document.documentElement.lang = next;

  setText('navDocs', t().navDocs);
  document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(b => {
    const isActive = b.dataset.lang === next;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', String(isActive));
  });

  // simple page-wide re-render to swap i18n strings
  renderSegments();
}

document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(b => {
  b.addEventListener('click', () => applyLanguage(b.dataset.lang as Lang));
});

document.documentElement.lang = lang;
renderSegments();
initCatalogFlow();

/* ---------------------------------------------------------------- *
 *  v0.3 catalog flow
 *
 *  Wires up:
 *    1. "Browse catalog" button  -> show device picker, fetch manifest
 *    2. Device <select> change   -> load that device's versions
 *    3. Version <select> change  -> mark catalogFirmware for download
 *    4. URL params at load time  -> skip the picker, go straight to
 *                                    a preselected (device, version) pair
 *  The Start flashing handler (above) reads catalogFirmware when
 *  sourceMode === 'catalog'.
 * ---------------------------------------------------------------- */

function setSourceMode(next: SourceMode) {
  sourceMode = next;
  const T = t();
  const desc = document.getElementById('step2Desc');
  const drop = document.getElementById('drop');
  const browseBtn = document.getElementById('browseCatalogBtn') as HTMLButtonElement | null;
  const catalogSection = document.getElementById('catalogSection');
  if (desc) desc.innerHTML = next === 'catalog' ? T.step2DescCatalog : T.step2DescUpload;
  if (drop) drop.classList.toggle('hidden', next === 'catalog');
  if (browseBtn) browseBtn.textContent = next === 'catalog' ? T.useLocalBin : T.browseCatalog;
  if (catalogSection) catalogSection.classList.toggle('hidden', next === 'upload');
  if (next === 'upload') {
    catalogFirmware = null;
    updateFlashBtnState();
  }
}

async function initCatalogFlow() {
  const T = t();
  const browseBtn = document.getElementById('browseCatalogBtn') as HTMLButtonElement | null;
  if (browseBtn) {
    browseBtn.addEventListener('click', () => {
      if (sourceMode === 'upload') {
        // entering catalog mode
        setSourceMode('catalog');
        void loadCatalogPicker();
      } else {
        // back to upload mode
        setSourceMode('upload');
        renderSegments();
      }
    });
  }

  if (!urlParams.deviceId) {
    // No URL preset; stay in upload mode until the user clicks "Browse catalog"
    return;
  }

  // URL has ?device=xxx[&version=yyy] -> enter catalog mode automatically
  setSourceMode('catalog');
  summaryEl.textContent = T.catalogLoading;
  try {
    const device = await fetchDevice(urlParams.deviceId);
    populateVersionDropdown(device);
    if (urlParams.version) {
      const found = device.versions.find(v => v.version === urlParams.version);
      if (found) {
        await selectCatalogFirmware(device, found);
        summaryEl.textContent = '';
      } else {
        summaryEl.textContent = T.catalogVersionMissing;
      }
    } else {
      summaryEl.textContent = '';
    }
  } catch (e) {
    const msg = e instanceof CatalogError ? friendlyCatalogError(e, T) : (e as Error).message;
    summaryEl.textContent = msg;
    summaryEl.classList.add('error');
  }
}

async function loadCatalogPicker() {
  const T = t();
  summaryEl.textContent = T.catalogLoading;
  try {
    const manifest = await fetchManifest();
    populateDeviceDropdown(manifest);
    summaryEl.textContent = '';
  } catch (e) {
    const msg = e instanceof CatalogError ? friendlyCatalogError(e, T) : (e as Error).message;
    summaryEl.textContent = msg;
    summaryEl.classList.add('error');
  }
}

function populateDeviceDropdown(manifest: { devices: Array<{ id: string; displayName: string; latestVersion: string }> }) {
  const sel = document.getElementById('catalogDevice') as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = '';
  if (!manifest.devices.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t().catalogEmpty;
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  for (const d of manifest.devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.displayName} (latest ${d.latestVersion})`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.onchange = () => {
    const id = sel.value;
    if (id) {
      void (async () => {
        const T2 = t();
        try {
          const device = await fetchDevice(id);
          populateVersionDropdown(device);
        } catch (e) {
          const msg = e instanceof CatalogError ? friendlyCatalogError(e, T2) : (e as Error).message;
          summaryEl.textContent = msg;
          summaryEl.classList.add('error');
        }
      })();
    }
  };
  // Auto-load first device's versions so the UI is one step ahead
  if (manifest.devices[0]) {
    sel.value = manifest.devices[0].id;
    void fetchDevice(manifest.devices[0].id).then(populateVersionDropdown).catch((e) => {
      const msg = e instanceof CatalogError ? friendlyCatalogError(e, T) : (e as Error).message;
      summaryEl.textContent = msg;
    });
  }
}

function populateVersionDropdown(device: DeviceDetails) {
  const T = t();
  const sel = document.getElementById('catalogVersion') as HTMLSelectElement | null;
  const hint = document.getElementById('catalogHint');
  if (!sel) return;
  sel.innerHTML = '';
  if (!device.versions.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = T.catalogEmpty;
    sel.appendChild(opt);
    sel.disabled = true;
    if (hint) hint.textContent = device.displayName;
    return;
  }
  for (const v of device.versions) {
    const opt = document.createElement('option');
    opt.value = v.version;
    opt.textContent = `${v.version} (${T.formatMb(v.size)})`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.onchange = () => {
    const v = device.versions.find(x => x.version === sel.value);
    if (v) void selectCatalogFirmware(device, v);
  };
  if (hint) hint.textContent = device.displayName;
  // Auto-pick the latest version
  if (device.versions[0]) {
    sel.value = device.versions[0].version;
    void selectCatalogFirmware(device, device.versions[0]);
  }
}

async function selectCatalogFirmware(device: DeviceDetails, version: FirmwareVersion) {
  catalogFirmware = { deviceId: device.id, version };
  const T = t();
  const sizeMB = T.formatMb(version.size);
  summaryEl.textContent = T.catalogSelected(device.displayName, version.version, sizeMB);
  summaryEl.classList.remove('error');
  updateFlashBtnState();
}
