import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { validateSegments, type FirmwareSegment } from './flasher';
import { STRINGS, type Lang } from './i18n';
import { flashEsp32, type FlashFile, type Phase } from './esp32/flasher';
import { describeUiConfig } from './esp32/flashConfig';
import type { ChipCode } from './esp32/chipDetect';

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
let mode: 'single' | 'multi' = 'single';
let lang: Lang = (localStorage.getItem('meshnology-lang') as Lang) || 'en';

let serialPort: SerialPort | null = null;
let portInfo: { usbVendorId?: number; usbProductId?: number } | null = null;

let flashConfig: FlashConfig = { mode: 'auto', freq: 'auto', size: 'auto' };

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
        <a href="https://github.com/zzzzccccbbbb/meshnology-flasher" target="_blank" rel="noreferrer" id="navGithub">${t().navGithub} ↗</a>
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
          <p>${t().step2Desc}</p>
          <div class="tabs">
            <button data-mode="single" class="tab active" id="tabSingle">${t().tabSingle}</button>
            <button data-mode="multi" class="tab" id="tabMulti">${t().tabMulti}</button>
          </div>
          <div id="drop" class="drop">
            <div class="upload-icon">↑</div>
            <b id="dropTitle">${t().dropTitle}</b>
            <span>${lang === 'zh' ? '或' : 'or'} <label for="fileInput">${t().dropBrowse}</label></span>
            <input id="fileInput" type="file" accept=".bin,application/octet-stream" multiple hidden />
          </div>
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
        <small>${formatBytes(s.size)}${mode === 'multi' ? ` · ${T.offsetLabel} <input data-offset="${i}" value="0x${s.offset.toString(16).padStart(4, '0')}" />` : ''}</small>
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
    segments.push({ name: file.name, size: file.size, offset: mode === 'single' ? 0 : 0x10000, file });
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

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(tab => {
  tab.onclick = () => {
    mode = tab.dataset.mode as 'single' | 'multi';
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    renderSegments();
  };
});

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
  flashBtn.disabled = !(segments.length > 0 && serialPort);
}

flashBtn.addEventListener('click', async () => {
  const T = t();
  if (!serialPort) {
    summaryEl.textContent = T.errNoPort;
    summaryEl.classList.add('error');
    return;
  }
  if (!segments.length) {
    summaryEl.textContent = T.errNoFirmware;
    summaryEl.classList.add('error');
    return;
  }
  const errs = validateSegments(segments);
  if (errs.length) {
    summaryEl.textContent = errs.join(' · ');
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

  const total = segments.reduce((n, s) => n + s.size, 0);
  progressBytes.textContent = `${formatBytes(0)} / ${formatBytes(total)}`;
  logEl.textContent = T.progressConnecting;
  termWrite(`[ui] starting flash — files=${segments.length}, total=${formatBytes(total)}, ${describeUiConfig(flashConfig)}`);

  // Read .bin bytes from File objects
  const files: FlashFile[] = await Promise.all(
    segments.map(async (s) => ({
      name: s.name,
      bytes: s.file ? new Uint8Array(await s.file.arrayBuffer()) : new Uint8Array(),
      offset: s.offset,
    })),
  );

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
  setText('navGithub', `${t().navGithub} ↗`);
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
