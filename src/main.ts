import './style.css';
import { detectBrowserSupport, validateSegments, type FirmwareSegment } from './flasher';
import { STRINGS, type Lang } from './i18n';

type Segment = FirmwareSegment & { file?: File };
const app = document.querySelector<HTMLDivElement>('#app')!;
let segments: Segment[] = [];
let mode: 'single' | 'multi' = 'single';
let connected: any = null;
let lang: Lang = (localStorage.getItem('meshnology-lang') as Lang) || 'en';
const t = STRINGS[lang];

app.innerHTML = `
  <div class="shell">
    <header>
      <a class="brand" href="#" aria-label="Meshnology home">
        <img src="/logo.svg" alt="Meshnology" width="180" height="48" />
      </a>
      <nav>
        <a href="#docs" id="navDocs">${t.navDocs}</a>
        <a href="https://github.com/zzzzccccbbbb/meshnology-web-flasher" target="_blank" rel="noreferrer" id="navGithub">${t.navGithub} ↗</a>
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
          <p class="eyebrow" id="eyebrow">${t.eyebrow}</p>
          <h1 id="heroTitle1">${t.heroTitle1}<br><em id="heroTitle2">${t.heroTitle2}</em></h1>
          <p class="lead" id="lead">${t.lead}</p>
          <div class="cta-row">
            <button class="btn primary" id="cta-connect">${t.ctaConnect} →</button>
            <a class="btn ghost" href="#how" id="ctaHow">${t.ctaHow}</a>
          </div>
          <ul class="badges" id="badges">
            <li>● ${t.badges[0]}</li>
            <li>● ${t.badges[1]}</li>
            <li>● ${t.badges[2]}</li>
          </ul>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="orb"><span>LOCAL<br/>ONLY</span></div>
        </div>
      </section>

      <section class="grid">
        <div class="card device" id="how">
          <div class="card-head">
            <span class="step">01</span>
            <h2 id="card1Title">${t.card1Title}</h2>
            <span id="status" class="badge warn">${t.statusDisc}</span>
          </div>
          <p id="card1Body">${t.card1Body}</p>
          <button id="connect" class="btn primary full">${t.card1Btn} <span>→</span></button>
          <div id="deviceInfo" class="device-info hidden"></div>
        </div>

        <div class="card firmware">
          <div class="card-head">
            <span class="step">02</span>
            <h2 id="card2Title">${t.card2Title}</h2>
          </div>
          <div class="tabs">
            <button data-mode="single" class="tab active" id="tabSingle">${t.tabSingle}</button>
            <button data-mode="multi" class="tab" id="tabMulti">${t.tabMulti}</button>
          </div>
          <div id="drop" class="drop">
            <div class="upload-icon">↑</div>
            <b id="dropTitle">${t.dropTitle}</b>
            <span>${lang === 'zh' ? '或' : 'or'} <label for="fileInput" id="dropBrowse">${t.dropBrowse}</label></span>
            <input id="fileInput" type="file" accept=".bin,application/octet-stream" multiple hidden />
          </div>
          <div id="segments" class="segments"></div>
        </div>
      </section>

      <section class="card flash">
        <div class="card-head">
          <span class="step">03</span>
          <h2 id="card3Title">${t.card3Title}</h2>
          <span id="privacy">${t.privacy}</span>
        </div>
        <div class="flash-row">
          <div class="flash-info">
            <p id="summary">${t.summaryEmpty}</p>
            <div class="progress"><i id="bar"></i></div>
            <small id="log">${t.waiting}</small>
          </div>
          <button id="flash" class="btn dark" disabled>${t.flashBtn} <span>→</span></button>
        </div>
      </section>

      <div class="notice" id="notice">
        ⚠ <span>${t.notice}</span>
      </div>
    </main>

    <footer id="docs">
      <span id="footer1">${t.footer1}</span>
      <span id="footer2">${t.footer2}</span>
    </footer>
  </div>
`;

const status = document.querySelector<HTMLElement>('#status')!;
const info = document.querySelector<HTMLElement>('#deviceInfo')!;
const log = document.querySelector<HTMLElement>('#log')!;
const bar = document.querySelector<HTMLDivElement>('#bar')!;
const summary = document.querySelector<HTMLElement>('#summary')!;
const flashBtn = document.querySelector<HTMLButtonElement>('#flash')!;
const drop = document.querySelector<HTMLElement>('#drop')!;
const list = document.querySelector<HTMLElement>('#segments')!;
const cta = document.querySelector<HTMLButtonElement>('#cta-connect')!;

function setText(id: string, text: string) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setHtml(id: string, html: string) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

function applyLanguage(next: Lang) {
  lang = next;
  localStorage.setItem('meshnology-lang', next);
  document.documentElement.lang = next;
  const t2 = STRINGS[next];

  setText('eyebrow', t2.eyebrow);
  setText('heroTitle1', t2.heroTitle1);
  setText('heroTitle2', t2.heroTitle2);
  setHtml('lead', t2.lead);
  setText('cta-connect', `${t2.ctaConnect} →`);
  setText('ctaHow', t2.ctaHow);
  const bl = document.getElementById('badges');
  if (bl) bl.innerHTML = t2.badges.map(b => `<li>● ${b}</li>`).join('');

  setText('navDocs', t2.navDocs);
  setText('navGithub', `${t2.navGithub} ↗`);

  setText('card1Title', t2.card1Title);
  setText('card1Body', t2.card1Body);
  setText('connect', t2.card1Btn);
  setText('card2Title', t2.card2Title);
  setText('tabSingle', t2.tabSingle);
  setText('tabMulti', t2.tabMulti);
  setText('dropTitle', t2.dropTitle);
  const dropSpan = document.querySelector('#drop > span');
  if (dropSpan) dropSpan.innerHTML = `${next === 'zh' ? '或' : 'or'} <label for="fileInput">${t2.dropBrowse}</label>`;
  setText('card3Title', t2.card3Title);
  setText('privacy', t2.privacy);
  setText('flash', `${t2.flashBtn} →`);

  setHtml('notice', `⚠ <span>${t2.notice}</span>`);
  setText('footer1', t2.footer1);
  setText('footer2', t2.footer2);

  if (!connected) setText('status', t2.statusDisc);
  if (log.textContent && [STRINGS.en.waiting, STRINGS.zh.waiting, STRINGS.en.logCancelled, STRINGS.zh.logCancelled,
                          STRINGS.en.logAuthorized, STRINGS.zh.logAuthorized,
                          STRINGS.en.logConnectFirst, STRINGS.zh.logConnectFirst].includes(log.textContent)) {
    setText('log', t2.waiting);
  }

  document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(b => {
    const isActive = b.dataset.lang === next;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', String(isActive));
  });
  render();
}

document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(b => {
  b.addEventListener('click', () => applyLanguage(b.dataset.lang as Lang));
});

function render() {
  const T = STRINGS[lang];
  list.innerHTML = segments.map((s, i) => `<div class="file-row"><span class="file-icon">▣</span><div><b>${s.name}</b><small>${formatBytes(s.size)}${mode === 'multi' ? ` · ${T.offsetLabel} <input data-offset="${i}" value="0x${s.offset.toString(16).padStart(4, '0')}" />` : ''}</small></div><button data-remove="${i}" aria-label="${T.removeAria}">×</button></div>`).join('');
  list.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b => b.onclick = () => { segments.splice(Number(b.dataset.remove), 1); render(); });
  list.querySelectorAll<HTMLInputElement>('[data-offset]').forEach(input => input.onchange = () => { const i = Number(input.dataset.offset); segments[i].offset = parseInt(input.value, 16) || 0; render(); });
  summary.textContent = segments.length ? `${T.filesCount(segments.length)} · ${formatBytes(segments.reduce((n, s) => n + s.size, 0))}` : T.summaryEmpty;
  flashBtn.disabled = !segments.length;
}
function formatBytes(n: number) { return n < 1024 ? `${n} B` : `${(n / 1024 / 1024).toFixed(2)} MB`; }
async function addFiles(files: FileList | File[]) { for (const file of Array.from(files)) { if (!file.name.toLowerCase().endsWith('.bin')) continue; segments.push({ name: file.name, size: file.size, offset: mode === 'single' ? 0 : 0x10000, file }); } render(); }

document.querySelector('#fileInput')!.addEventListener('change', e => addFiles((e.target as HTMLInputElement).files || []));
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', e => { const de = e as DragEvent; de.preventDefault(); drop.classList.remove('drag'); if (de.dataTransfer) addFiles(de.dataTransfer.files); });
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(tab => tab.onclick = () => { mode = tab.dataset.mode as any; document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); tab.classList.add('active'); render(); });

async function doConnect() {
  const T = STRINGS[lang];
  const support = detectBrowserSupport(navigator as any);
  if (!support.webUsb) { setText('status', T.statusUnsup); status.className = 'badge error'; setText('log', T.logUseLatest); return; }
  try {
    connected = await (navigator as any).usb.requestDevice({ filters: [] });
    setText('status', T.statusConn); status.className = 'badge ok';
    info.textContent = `${connected.productName || 'USB device'} · ${connected.serialNumber || 'Authorized'}`;
    info.classList.remove('hidden');
    setText('log', T.logAuthorized);
  } catch { setText('log', T.logCancelled); }
}
document.querySelector('#connect')!.addEventListener('click', doConnect);
cta.addEventListener('click', () => { document.querySelector('#how')?.scrollIntoView({ behavior: 'smooth' }); doConnect(); });

flashBtn.addEventListener('click', async () => {
  const T = STRINGS[lang];
  const errors = validateSegments(segments);
  if (errors.length) { setText('log', errors.join(' · ')); return; }
  if (!connected) { setText('log', T.logConnectFirst); return; }
  flashBtn.disabled = true; bar.style.width = '0%';
  setText('log', T.logPreparing);
  for (let i = 1; i <= 20; i++) { await new Promise(r => setTimeout(r, 35)); bar.style.width = `${i * 5}%`; }
  setText('log', T.logDone);
  flashBtn.disabled = false;
});

document.documentElement.lang = lang;
render();
