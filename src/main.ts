import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { validateSegments, type FirmwareSegment } from './flasher';
import { STRINGS, type Lang } from './i18n';
import { flashEsp32, type FlashFile, type Phase } from './esp32/flasher';
import { describeUiConfig } from './esp32/flashConfig';
import type { ChipCode } from './esp32/chipDetect';
import { parseIntelHex, toSparseImage, HexParseError } from './nrf/uf2';
import {
  flashNrfDfu, isWebSerialAvailable, requestDfuPort, dfuErrorToMessage,
} from './nrf/dfuTransport';
import { fetchManifest, fetchDevice, CatalogError } from './catalog/api';
import { downloadFirmware } from './catalog/reader';
import {
  hexToNrfImage, describeNrfImage, fetchNrfFirmware, type NrfImage,
} from './catalog/nrfReader';
import { parseDfuPackage, describeDfuPackage } from './nrf/dfuPackage';
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
// v0.3 brought back the v0.2 single/multi tab in the upload step (per
// user request). The current mode drives auto-assigned offsets in
// addFiles() and whether the per-file offset input is rendered in
// renderSegments().
let uploadMode: 'single' | 'multi' = 'single';
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

/**
 * Chip family drives the whole flashing pipeline, not just labels:
 *   esp32    — .bin over Web Serial through esptool.js's ROM loader
 *   nrf52840 — .hex/.uf2 written to a UF2 bootloader over WebUSB
 * The two paths share nothing below this point, so the branch is made once,
 * here, instead of being threaded through every helper.
 */
type ChipFamily = 'esp32' | 'nrf52840';
let chipFamily: ChipFamily = 'esp32';
/** The bootloader handle, once the user has picked it. */
let nrfDevice: unknown = null;
/**
 * Cooperative cancel flag shared with the transports. The nRF path polls it
 * between block-status reads; the esptool.js path has no equivalent hook,
 * which is why its abort button closes the port instead.
 */
const abortFlag = { aborted: false };

/**
 * Protocol-level erase before the nRF write.
 *
 * START already erases every page named in the init packet, so a normal
 * flash is already a fresh page write. Setting this adds explicit ERASE_PAGE
 * packets first, which is what MeshCore's "Erase flash" option does — useful
 * when the board has stale app data in pages this image does not cover.
 */
let nrfErase = false;

/**
 * Reset the board into DFU before writing.
 *
 * Off by default. The board's bootloader is an Adafruit Feather UF2 one
 * that presents a serial port alongside its mass-storage volume, and
 * adafruit-nrfutil programs it successfully with the touch step disabled:
 * the operator double-taps RESET to enter DFU, then the tool talks to the
 * port as-is. A 1200-baud open has not been observed to work on this
 * bootloader, so the automatic reset is opt-in.
 */
let nrfAutoReset = false;

interface Preselected {
  deviceId: string | null;
  version: string | null;
}
const urlParams: Preselected = parseUrlParams();

/** In catalog mode, the bytes are fetched from R2 (well, Pages static)
 *  just before Start flashing, then verified by SHA-256. */
/**
 * The preselected catalog firmware. The device record is kept alongside the
 * version because it carries `chipFamily` and `displayName` — the UI needs
 * both to route the write down the right transport and to label the progress
 * line.
 */
let catalogFirmware: {
  deviceId: string;
  device: DeviceDetails | null;
  version: FirmwareVersion;
} | null = null;

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
      <nav>
        <div class="lang-switch" role="tablist" aria-label="Language">
          <button data-lang="en" class="lang-btn${lang === 'en' ? ' active' : ''}" aria-selected="${lang === 'en'}">EN</button>
          <span class="lang-sep">|</span>
          <button data-lang="zh" class="lang-btn${lang === 'zh' ? ' active' : ''}" aria-selected="${lang === 'zh'}">中</button>
        </div>
      </nav>
    </header>

    <main>
      <div class="page-head">
        <h2 data-i18n="pageTitle">${t().pageTitle}</h2>
        <p data-i18n="pageDesc">${t().pageDesc}</p>
      </div>

      <!-- 16302-style two-column file box: left 35% = device/serial,
           right 65% = firmware selection + flash config -->
      <section class="file-box">
        <div class="file-col file-left">
          <div class="col-title col-title-type">
            <span class="col-icon">▤</span><span data-i18n="colDevice">${t().colDevice}</span>
          </div>

          <div id="serialStatus" class="badge idle">${t().step1StatusDisc}</div>

          <button id="serialConnect" class="btn primary full"><span data-i18n="step1Btn">${t().step1Btn}</span> <span>→</span></button>
          <div id="serialInfo" class="serial-info hidden"></div>
          <small id="serialLog" style="display:block;margin-top:10px;color:var(--text-faint);font:11px ui-monospace,monospace">${t().step1LogChoose}</small>

          <div class="config-field" style="margin-top:4px">
            <label for="chipFamily" data-i18n="chipFamilyLabel">${t().chipFamilyLabel}</label>
            <select id="chipFamily">
              <option value="esp32" selected>${t().chipFamilyEsp32}</option>
              <option value="nrf52840">${t().chipFamilyNrf}</option>
            </select>
            <p class="config-hint" id="chipFamilyHint" data-i18n="chipFamilyHintEsp">${t().chipFamilyHintEsp}</p>
          </div>

          <div class="chip-selected">
            <div class="chip-selected-inner">
              <span class="chip-selected-label" data-i18n="chipLabel">${t().chipLabel}</span>
              <span class="chip-selected-value" id="chipValue">${t().chipUnknown}</span>
            </div>
          </div>
        </div>

        <div class="file-col file-right">
          <div class="col-title col-title-file">
            <span class="col-icon">▣</span><span data-i18n="colFirmware">${t().colFirmware}</span>
          </div>

          <!-- Source mode: local upload vs. device catalog -->
          <div class="tabs source-tabs" id="sourceTabs">
            <button data-source="upload" class="tab active" id="srcUpload" data-i18n="srcUpload">${t().srcUpload}</button>
            <button data-source="catalog" class="tab" id="srcCatalog" data-i18n="srcCatalog">${t().srcCatalog}</button>
          </div>

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

          <div id="uploadSection">
            <div class="tabs" id="uploadTabs">
              <button data-mode="single" class="tab active" id="tabSingle" data-i18n="tabSingle">${t().tabSingle}</button>
              <button data-mode="multi" class="tab" id="tabMulti" data-i18n="tabMulti">${t().tabMulti}</button>
            </div>
            <div id="nrfOptions" class="nrf-options hidden">
              <label class="check">
                <input type="checkbox" id="nrfErase" />
                <span data-i18n="nrfEraseLabel">${t().nrfEraseLabel}</span>
              </label>
              <p class="config-hint" data-i18n="nrfEraseHint">${t().nrfEraseHint}</p>
              <label class="check">
                <input type="checkbox" id="nrfAutoReset" />
                <span data-i18n="nrfAutoResetLabel">${t().nrfAutoResetLabel}</span>
              </label>
              <p class="config-hint" data-i18n="nrfAutoResetHint">${t().nrfAutoResetHint}</p>
            </div>
            <div id="drop" class="drop">
              <div class="upload-icon">↑</div>
              <!-- No data-i18n here: which text this shows depends on the chip family,
                   so applyChipFamily owns it. -->
              <b id="dropTitle">${t().dropTitle}</b>
              <span><span id="dropOr">${lang === 'zh' ? '或' : 'or'}</span> <label for="fileInput" data-i18n="dropBrowse">${t().dropBrowse}</label></span>
              <input id="fileInput" type="file" accept=".bin,application/octet-stream" multiple hidden />
            </div>
            <div id="segments" class="segments"></div>
          </div>

          <div class="config-block">
            <div class="config-title">
              <span data-i18n="configTitle">${t().configTitle}</span>
            </div>
            <p class="config-hint" data-i18n="configHint">${t().configHint}</p>
            <div class="config-grid">
              <div class="config-field">
                <label for="cfgMode" data-i18n="configMode">${t().configMode}</label>
                <select id="cfgMode">
                  <option value="auto">${t().configAuto}</option>
                  <option value="QIO">QIO</option>
                  <option value="QOUT">QOUT</option>
                  <option value="DIO">DIO</option>
                  <option value="DOUT">DOUT</option>
                </select>
              </div>
              <div class="config-field">
                <label for="cfgFreq" data-i18n="configFreq">${t().configFreq}</label>
                <select id="cfgFreq">
                  <option value="auto">${t().configAuto}</option>
                  <option value="40m">40 MHz</option>
                  <option value="80m">80 MHz</option>
                </select>
              </div>
              <div class="config-field">
                <label for="cfgSize" data-i18n="configSize">${t().configSize}</label>
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
      </section>

      <!-- One burn button; its label follows the selected source + upload mode. -->
      <section class="burn-row" id="step-3">
        <div class="burn-meta" id="flashMeta">
          <span><span class="meta-key">${t().chipLabel}:</span><span class="meta-value" id="chipValue2">${t().chipUnknown}</span></span>
        </div>

        <div class="burn-buttons">
          <button id="flashBtn" class="btn burn primary-burn" data-i18n="burnSingle">${t().burnSingle}</button>
          <button id="abortBtn" class="btn danger hidden" data-i18n="abortBtn">${t().abortBtn}</button>
        </div>

        <div class="flash-progress">
          <p class="summary" id="summary">${t().progressEmpty}</p>
          <div class="progress"><i id="bar"></i></div>
          <div class="progress-meta">
            <span id="log">${t().progressIdle}</span>
            <span id="progressBytes">0 B / 0 B</span>
          </div>
        </div>

        <div class="terminal-section">
          <div class="terminal-head">
            <span class="label" data-i18n="terminalLabel">${t().terminalLabel}</span>
          </div>
          <div class="terminal-container" id="termContainer">
            <div class="terminal-empty" id="termEmpty">${t().terminalEmpty}</div>
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
const chipValue2 = $('#chipValue2');
const chipFamilySel = $<HTMLSelectElement>('#chipFamily');
const chipFamilyHint = $('#chipFamilyHint');

const cfgMode = $<HTMLSelectElement>('#cfgMode');
const cfgFreq = $<HTMLSelectElement>('#cfgFreq');
const cfgSize = $<HTMLSelectElement>('#cfgSize');

const termContainer = $('#termContainer');
const termEmpty = $('#termEmpty');

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
  // offsetInput: render the per-file offset input only in multi mode
  // and only when segments actually need a non-default offset.
  // (The v0.2 logic rendered it always when mode==='multi' but mode
  // was deleted in v0.3; restoring it but keyed off a new single/multi
  // tab selection.)
  list.innerHTML = segments.map((s, i) => `
    <div class="file-row">
      <span class="file-icon">▣</span>
      <div>
        <b>${s.name}</b>
        <small>${formatBytes(s.size)}${uploadMode === 'multi' ? ` · ${T.offsetLabel} <input data-offset="${i}" value="0x${s.offset.toString(16).padStart(4, '0')}" />` : ''}</small>
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

const ALLOWED_EXT = {
    esp32: ['.bin'],
    // DFU takes a flat image or a package: Intel HEX and raw .bin carry their
    // own content, and a .dfu/.zip is an Adafruit/Nordic DFU package that we
    // unpack in the browser. UF2 is deliberately absent — it is a bootloader
    // container for mass-storage flashing, not something serial DFU carries.
    nrf52840: ['.hex', '.bin', '.dfu', '.zip'],
  } as const;

async function addFiles(files: FileList | File[]) {
  // In multi mode, auto-assign offsets following the ESP-IDF layout
  // that `idf.py build` writes to build/flash_args:
  //   1st file -> 0x0       (bootloader)
  //   2nd file -> 0x8000    (partition table)
  //   3rd file -> 0x10000   (app)
  //   Nth (N>3) -> 0x10000 + sum of preceding file sizes
  // In single mode, all files share offset 0 (the v0.2 behavior; the
  // .bin is expected to be a merged image, not just an app).
  //
  // nRF52840 has no offsets to assign: a .hex carries its own addresses and
  // is packed into a .uf2 whose blocks each name their target, so the offset
  // column stays at 0 and the single/multi tabs are hidden for that family.
  const allowed = ALLOWED_EXT[chipFamily] as readonly string[];
  for (const file of Array.from(files)) {
    const lower = file.name.toLowerCase();
    if (!allowed.some(ext => lower.endsWith(ext))) continue;
    let offset: number;
    if (uploadMode === 'multi') {
      const n = segments.length;
      if (n === 0) offset = 0x0;
      else if (n === 1) offset = 0x8000;
      else if (n === 2) offset = 0x10000;
      else {
        // 0x10000 + sum of sizes of the first n segments (bytes)
        const base = 0x10000;
        const sum = segments.slice(0, n).reduce((acc, s) => acc + s.size, 0);
        offset = base + sum;
      }
    } else {
      offset = 0;
    }
    segments.push({ name: file.name, size: file.size, offset, file });
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

// Single / multi upload tab toggling
document.querySelectorAll<HTMLButtonElement>('#uploadTabs [data-mode]').forEach(tab => {
  tab.onclick = () => {
    const next = tab.dataset.mode as 'single' | 'multi';
    if (next === uploadMode) return;
    uploadMode = next;
    document.querySelectorAll('#uploadTabs .tab').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
    // When switching modes, drop any segments whose offsets no longer
    // make sense (single mode strips offsets to 0; multi mode reuses
    // the existing offsets the user already entered). For simplicity
    // we keep segments across mode switches and only re-render — the
    // offset input visibility is mode-driven, not the data.
    renderSegments();
    // The burn button's label follows the mode, so refresh it too.
    updateFlashBtnState();
  };
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
  if (chipFamily === 'nrf52840') {
    await doNrfBootConnect();
    return;
  }
  if (serialPort) await doSerialDisconnect();
  else await doSerialConnect();
});

/**
 * nRF52840: pick the board's serial port.
 *
 * The port is the same USB CDC the board uses for its application (the W13
 * shows up as 239a:8029). No bootloader button is involved — flashNrfDfu
 * reboots the chip into DFU itself by opening the port at 1200 baud and
 * closing it, the standard nRF "touch reset".
 */
async function doNrfBootConnect() {
  const T = t();
  if (!isWebSerialAvailable()) {
    serialStatus.className = 'badge error';
    serialStatus.textContent = 'Web Serial unavailable';
    summaryEl.textContent = 'This browser has no Web Serial. Use Chrome or Edge.';
    summaryEl.classList.add('error');
    return;
  }
  serialStatus.className = 'badge busy';
  serialStatus.textContent = T.catalogLoading;
  termWrite('[dfu] requesting serial port…');
  try {
    const port = await requestDfuPort();
    nrfDevice = port;
    const info = await port.getInfo();
    const name = vendorName(info.usbVendorId) + (info.productName ? ` · ${info.productName}` : '');
    serialStatus.className = 'badge ok';
    serialStatus.textContent = name;
    serialInfo.textContent = `[dfu] port selected: ${name}`;
    serialInfo.classList.remove('hidden');
    termWrite(`[dfu] serial port selected: ${name}`);
    summaryEl.classList.remove('error');
  } catch (e) {
    const { message } = dfuErrorToMessage(e);
    nrfDevice = null;
    serialStatus.className = 'badge error';
    serialStatus.textContent = T.nrfNotReady;
    summaryEl.textContent = message;
    summaryEl.classList.add('error');
    termWrite(`! ${message}`);
    termWrite(`! raw: ${(e as Error)?.stack ?? String(e)}`);
  }
  updateFlashBtnState();
}

/* ---------------------------------------------------------------- *
 *  FlashConfig wiring
 * ---------------------------------------------------------------- */

cfgMode.onchange = () => { flashConfig.mode = cfgMode.value; };
cfgFreq.onchange = () => { flashConfig.freq = cfgFreq.value; };
cfgSize.onchange = () => { flashConfig.size = cfgSize.value; };

/* ---------------------------------------------------------------- *
 *  Flash button gating + click handler
 * ---------------------------------------------------------------- */

/** Label for the single burn button. It follows the active selection so
 *  the button always says what it is about to do:
 *    upload  + single -> one merged .bin at 0x0
 *    upload  + multi  -> N files at their own offsets
 *    catalog           -> the catalog build for the chosen device
 *    nRF52840          -> the UF2 file written to the bootloader
 */
function burnButtonLabel(T: ReturnType<typeof t>): string {
  if (chipFamily === 'nrf52840') return T.burnNrf;
  if (sourceMode === 'catalog') return T.burnCatalog;
  return uploadMode === 'multi' ? T.burnMulti : T.burnSingle;
}

function updateFlashBtnState() {
  // What counts as "connected" depends on the family: the ESP32 path holds a
  // Web Serial port open in `serialPort`, while the nRF path holds its port in
  // `nrfDevice` and never assigns serialPort — they are separate transports,
  // not two names for the same thing.
  const connected = chipFamily === 'nrf52840' ? nrfDevice !== null : serialPort !== null;

  let ready: boolean;
  if (sourceMode === 'catalog') {
    // A preselected catalog firmware stands in for an uploaded file.
    ready = connected && catalogFirmware !== null;
  } else {
    ready = connected && segments.length > 0;
  }
  flashBtn.disabled = !ready;
  flashBtn.textContent = burnButtonLabel(t());
}

function setBurnDisabled(disabled: boolean): void {
  flashBtn.disabled = disabled;
}

flashBtn.addEventListener('click', () => void runFlash());

/**
 * Where the nRF image comes from: a file the user dropped, or a catalog
 * firmware that still has to be fetched. Both end up as the same flat image.
 */
type NrfSource =
  | { kind: 'file'; file: File; name: string }
  | { kind: 'catalog'; deviceId: string; version: FirmwareVersion };

/** The firmware the nRF path should write, if any. */
function nrfSource(): NrfSource | null {
  if (sourceMode === 'catalog') {
    if (!catalogFirmware) return null;
    return {
      kind: 'catalog',
      deviceId: catalogFirmware.deviceId,
      version: catalogFirmware.version,
    };
  }
  const seg = segments[0];
  if (!seg?.file) return null;
  return { kind: 'file', file: seg.file, name: seg.name };
}

/** Decode an nRF source into a flat image plus its base address. */
async function loadNrfImage(src: NrfSource): Promise<NrfImage> {
  if (src.kind === 'catalog') {
    return fetchNrfFirmware(src.deviceId, src.version, termWrite);
  }

  const lower = src.name.toLowerCase();
  if (lower.endsWith('.bin')) {
    const bytes = new Uint8Array(await src.file.arrayBuffer());
    return {
      bytes,
      startAddress: 0,
      endAddress: bytes.byteLength,
      pages: Math.ceil(bytes.byteLength / 4096),
    };
  }
  if (lower.endsWith('.dfu') || lower.endsWith('.zip')) {
    const pkg = parseDfuPackage(new Uint8Array(await src.file.arrayBuffer()));
    const base = 0x27000;
    termWrite(`[dfu] ${describeDfuPackage(pkg, base)}`);
    if (pkg.softdeviceReqLabel) {
      termWrite(`[dfu] the board must already carry SoftDevice ${pkg.softdeviceReqLabel}`);
    }
    return {
      bytes: pkg.image,
      startAddress: base,
      endAddress: base + pkg.image.byteLength,
      pages: Math.ceil(pkg.image.byteLength / 4096),
    };
  }
  return hexToNrfImage(await src.file.text());
}

/**
 * nRF52840 flash over Nordic's serial DFU protocol.
 *
 * The image comes from either a dropped file or the catalog; both are decoded
 * to a flat image with a base address, which is what the DFU init packet is
 * built from at flash time. The board reboots into its bootloader by itself
 * (the 1200-baud touch reset inside flashNrfDfu), so no button is involved.
 */
async function runNrfFlash(): Promise<void> {
  const T = t();
  if (nrfDevice === null) {
    summaryEl.textContent = T.nrfNotReady;
    summaryEl.classList.add('error');
    return;
  }
  const src = nrfSource();
  if (src === null) {
    summaryEl.textContent = T.errNoFirmware;
    summaryEl.classList.add('error');
    return;
  }

  setBurnDisabled(true);
  abortFlag.aborted = false;
  abortBtn.classList.remove('hidden');
  bar.style.width = '0%';
  summaryEl.classList.remove('error');
  ensureTerminal();

  const label = src.kind === 'catalog' ? src.version.filename : src.name;

  try {
    // DFU wants a flat image and its base address, not a container format.
    // loadNrfImage produces exactly that from either source, filling linker
    // holes between HEX records with 0xFF.
    const img = await loadNrfImage(src);
    termWrite(`[dfu] ${label}: ${describeNrfImage(img)}`);

    progressBytes.textContent = `${formatBytes(0)} / ${formatBytes(img.bytes.byteLength)}`;

    const phaseText: Record<string, string> = {
      'entering-dfu': T.progressConnecting,
      opening: T.progressConnecting,
      init: T.progressDetecting,
      start: T.progressErasing,
      erasing: T.progressErasing,
      writing: T.progressWriting,
      finishing: T.progressVerifying,
      done: T.progressDone,
    };

    await flashNrfDfu(
      nrfDevice as SerialPort,
      { image: img.bytes, startAddress: img.startAddress, erase: nrfErase, touchReset: nrfAutoReset, initPacket: img.initPacket },
      {
        onPhase: phase => {
          const phaseName = phaseText[phase];
          if (phaseName) logEl.textContent = phaseName;
        },
        onProgress: (sent, total) => {
          const pct = total > 0 ? Math.floor((sent / total) * 100) : 0;
          bar.style.width = `${pct}%`;
          progressBytes.textContent = `${formatBytes(sent)} / ${formatBytes(total)}`;
        },
        onLog: line => termWrite(line),
        onError: (_kind, msg) => {
          summaryEl.textContent = msg;
          summaryEl.classList.add('error');
          termWrite(`! ${msg}`);
        },
      },
      abortFlag,
    );

    summaryEl.textContent = T.progressDone;
    summaryEl.classList.remove('error');
  } catch (e) {
    const { message } = dfuErrorToMessage(e);
    summaryEl.textContent = message;
    summaryEl.classList.add('error');
    termWrite(`! ${message}`);
  } finally {
    setBurnDisabled(false);
    abortBtn.classList.add('hidden');
    // The bootloader rebooted the board, so the port handle is spent.
    nrfDevice = null;
    serialStatus.className = 'badge idle';
    serialStatus.textContent = T.nrfNotReady;
  }
}

/** Run the flash flow with whatever chip family + source + mode is selected. */
async function runFlash(): Promise<void> {
  if (chipFamily === 'nrf52840') {
    await runNrfFlash();
    return;
  }
  const T = t();
  if (!serialPort) {
    summaryEl.textContent = T.errNoPort;
    summaryEl.classList.add('error');
    return;
  }
  // Stage 2: real flash via esptool.js
  setBurnDisabled(true);
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
        setBurnDisabled(false);
        abortBtn.classList.add('hidden');
        mainEl.classList.remove('is-flashing');
        return;
      }
      const segErrs = validateSegments(segments);
      if (segErrs.length) {
        summaryEl.textContent = segErrs.join(' · ');
        summaryEl.classList.add('error');
        setBurnDisabled(false);
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
        setBurnDisabled(false);
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
        setBurnDisabled(false);
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
    setBurnDisabled(false);
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
          // Two chip readouts in the new layout: the "已选芯片" chip in
          // the left file-box column, and the meta line in the burn row.
          const txt = `${name} (${code})`;
          chipValue.textContent = txt;
          chipValue2.textContent = txt;
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

  setBurnDisabled(false);
  abortBtn.classList.add('hidden');
  mainEl.classList.remove('is-flashing');
}

abortBtn.addEventListener('click', () => {
  abortFlag.aborted = true;
  setBurnDisabled(false);
  abortBtn.classList.add('hidden');
  mainEl.classList.remove('is-flashing');
  bar.style.width = '0%';
  logEl.textContent = t().progressCancelled;
  termWrite(`> ${t().progressCancelled}`);
});

/* ---------------------------------------------------------------- *
 *  Chip family: ESP32 (esptool.js / Web Serial) vs nRF52840 (UF2 / WebUSB)
 * ---------------------------------------------------------------- */

/**
 * Switch the whole page between the two chip families.
 *
 * The differences are more than a transport swap:
 *   - the connect button means different things (open a serial port vs.
 *     pick a USB bootloader)
 *   - the firmware extension differs (.bin vs .hex/.uf2), so the file
 *     input's accept list and the drop-zone copy change
 *   - the flash parameters block (SPI mode / frequency / size) is an
 *     esptool.js concept and has no meaning for UF2
 *   - nRF needs WebUSB, which only Chrome and Edge implement
 */
function applyChipFamily(next: ChipFamily): void {
  const previous = chipFamily;
  chipFamily = next;
  const T = t();

  chipFamilySel.value = next;
  // The <option> labels are static markup, so a language switch has to
  // rewrite them here rather than through the generic data-i18n walk.
  const optEsp = chipFamilySel.querySelector<HTMLOptionElement>('option[value="esp32"]');
  const optNrf = chipFamilySel.querySelector<HTMLOptionElement>('option[value="nrf52840"]');
  if (optEsp) optEsp.textContent = T.chipFamilyEsp32;
  if (optNrf) optNrf.textContent = T.chipFamilyNrf;
  if (chipFamilyHint) {
    chipFamilyHint.textContent =
      next === 'nrf52840' ? T.chipFamilyHintNrf : T.chipFamilyHintEsp;
    chipFamilyHint.removeAttribute('data-i18n');
  }

  // Connect button.
  if (next === 'nrf52840') {
    setText('serialConnect', T.nrfBootBtn);
    serialConnectBtn.classList.remove('primary');
    serialConnectBtn.classList.add('warn');
    setText('serialLog', T.nrfBootHint);
  } else {
    setText('serialConnect', `${T.step1Btn} `);
    serialConnectBtn.classList.add('primary');
    serialConnectBtn.classList.remove('warn');
    setText('serialLog', T.step1LogChoose);
  }

  // Firmware file types.
  fileInput.accept = next === 'nrf52840' ? '.hex,.bin,.dfu,.zip' : '.bin,application/octet-stream';
  setText('dropTitle', next === 'nrf52840' ? T.dropTitleNrf : T.dropTitle);

  // Flash parameters are esptool.js-only.
  const configBlock = document.querySelector<HTMLElement>('.config-block');
  if (configBlock) configBlock.classList.toggle('hidden', next !== 'esp32');

  // Multi-file offsets are an esptool.js concept too: UF2 blocks each carry
  // their own address, so "several files at hand-set offsets" has no analogue.
  const uploadTabs = document.getElementById('uploadTabs');
  if (uploadTabs) uploadTabs.classList.toggle('hidden', next !== 'esp32');

  // The nRF-only options: explicit erase before writing. START erases the
  // pages the init packet names either way; this is the extra full-range wipe.
  const nrfOptions = document.getElementById('nrfOptions');
  if (nrfOptions) nrfOptions.classList.toggle('hidden', next !== 'nrf52840');

  // A handle from the other family is meaningless here — the ESP32 path
  // talks esptool.js over `serialPort`, the nRF path drives Nordic DFU over
  // `nrfDevice`, and neither can use the other's port. Drop the stale one so
  // the burn button reflects what is actually connected instead of latching
  // onto a handle the new path will never touch.
  if (previous !== next) {
    if (next === 'esp32' && nrfDevice !== null) {
      nrfDevice = null;
      termWrite('[ui] closed the nRF port handle: chip family changed to ESP32');
    }
    if (next === 'nrf52840' && serialPort !== null) {
      void doSerialDisconnect();
      termWrite('[ui] closed the serial port: chip family changed to nRF52840');
    }
  }

  if (next === 'nrf52840' && !isWebSerialAvailable()) {
    serialStatus.className = 'badge warn';
    serialStatus.textContent = 'Web Serial unavailable';
  } else {
    serialStatus.className = 'badge idle';
    serialStatus.textContent = next === 'nrf52840' ? T.nrfNotReady : T.step1StatusDisc;
  }

  updateFlashBtnState();
}

chipFamilySel.addEventListener('change', () => {
  applyChipFamily(chipFamilySel.value as ChipFamily);
});

$<HTMLInputElement>('#nrfErase').addEventListener('change', e => {
  nrfErase = (e.target as HTMLInputElement).checked;
  if (nrfErase) termWrite('[dfu] erase-before-write enabled');
});

$<HTMLInputElement>('#nrfAutoReset').addEventListener('change', e => {
  nrfAutoReset = (e.target as HTMLInputElement).checked;
  termWrite(nrfAutoReset
    ? '[dfu] the port will be reset at 1200 baud to enter the bootloader'
    : '[dfu] no auto reset: put the board in DFU mode (double-tap RESET) first');
});

/* ---------------------------------------------------------------- *
 *  Language switcher
 * ---------------------------------------------------------------- */

function applyLanguage(next: Lang) {
  lang = next;
  localStorage.setItem('meshnology-lang', next);
  document.documentElement.lang = next;

  document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(b => {
    const isActive = b.dataset.lang === next;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', String(isActive));
  });

  // Swap every static string in place. The shell HTML is built once at
  // module load (DOM refs below are captured once), so a full re-render
  // would orphan them; data-i18n keeps the language switch cheap and safe.
  const T = t();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n as keyof typeof STRINGS[Lang];
    const val = T[key];
    if (typeof val === 'string') el.textContent = val;
  });

  // The chip-family hint is not a plain data-i18n string: which text it shows
  // depends on the selected family, so it is refreshed from applyChipFamily
  // instead of the generic walk above.
  if (chipFamilyHint) {
    chipFamilyHint.textContent =
      chipFamily === 'nrf52840' ? T.chipFamilyHintNrf : T.chipFamilyHintEsp;
  }

  // Same for the family <select>: its <option> labels are static markup, and
  // applyChipFamily also rewrites the connect button, drop-zone copy and the
  // burn label, all of which are family-dependent.
  applyChipFamily(chipFamily);

  // The drop-zone separator word ("or") is a bare text node with no i18n
  // key of its own; patch it directly.
  setText('dropOr', next === 'zh' ? '或' : 'or');

  // Live regions that hold runtime state are refreshed by their own
  // update paths; only the static fallbacks need a nudge here.
  // dropTitle is deliberately absent: applyChipFamily above already set it
  // to the copy that matches the selected family.
  setText('serialStatus', T.step1StatusDisc);
  setText('chipValue', T.chipUnknown);
  setText('chipValue2', T.chipUnknown);
  renderSegments();
}

document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(b => {
  b.addEventListener('click', () => applyLanguage(b.dataset.lang as Lang));
});

document.documentElement.lang = lang;
renderSegments();
initCatalogFlow();
// Apply the initial chip family so its side effects (file extensions, the
// config block, the multi-offset tabs) are reflected without needing a
// change event first.
applyChipFamily(chipFamily);

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
  const catalogSection = document.getElementById('catalogSection');
  const uploadSection = document.getElementById('uploadSection');
  const sourceTabs = document.getElementById('sourceTabs');
  if (catalogSection) catalogSection.classList.toggle('hidden', next !== 'catalog');
  if (uploadSection) uploadSection.classList.toggle('hidden', next !== 'upload');
  // Reflect the active source in the two mode tabs. The single/multi
  // upload tabs live inside #uploadSection, which is hidden wholesale
  // in catalog mode, so they need no separate visibility handling.
  if (sourceTabs) {
    sourceTabs.querySelectorAll<HTMLButtonElement>('.tab').forEach(b => {
      b.classList.toggle('active', (b.dataset.source as SourceMode) === next);
    });
  }
  if (next === 'upload') {
    catalogFirmware = null;
  }
  updateFlashBtnState();
}

async function initCatalogFlow() {
  const sourceTabs = document.getElementById('sourceTabs');
  if (sourceTabs) {
    sourceTabs.querySelectorAll<HTMLButtonElement>('.tab').forEach(b => {
      b.addEventListener('click', () => {
        const next = b.dataset.source as SourceMode;
        if (next === sourceMode) return;
        if (next === 'catalog') {
          setSourceMode('catalog');
          void loadCatalogPicker();
        } else {
          setSourceMode('upload');
          renderSegments();
        }
      });
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
    // A device whose firmware has not been published yet carries an empty
    // latestVersion; showing "(latest )" reads like a bug.
    opt.textContent = d.latestVersion
      ? `${d.displayName} (latest ${d.latestVersion})`
      : d.displayName;
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
  // A catalog entry knows which chip family it needs, so picking a device is
  // enough to route the whole page — the user should not have to also flip
  // the chip selector. Without this, choosing an nRF board while ESP32 mode is
  // active would download a .hex and hand it to esptool.js.
  const wantFamily: ChipFamily = device.chipFamily ?? 'esp32';
  if (wantFamily !== chipFamily) {
    applyChipFamily(wantFamily);
    termWrite(`[catalog] ${device.displayName} needs the ${wantFamily} path; switched automatically`);
  }

  catalogFirmware = { deviceId: device.id, device, version };
  const T = t();
  const sizeMB = T.formatMb(version.size);
  summaryEl.textContent = T.catalogSelected(device.displayName, version.version, sizeMB);
  summaryEl.classList.remove('error');
  updateFlashBtnState();
}
