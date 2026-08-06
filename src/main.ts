import './style.css';
import { detectBrowserSupport, validateSegments, type FirmwareSegment } from './flasher';

type Segment = FirmwareSegment & { file?: File };
const app = document.querySelector<HTMLDivElement>('#app')!;
let segments: Segment[] = [];
let mode: 'single'|'multi' = 'single';
let connected: any = null;

app.innerHTML = `
  <div class="shell">
    <header>
      <a class="brand" href="#" aria-label="Meshnology home">
        <img src="/logo.svg" alt="Meshnology" width="180" height="48" />
      </a>
      <nav>
        <a href="#docs">Docs</a>
        <a href="https://github.com/zzzzccccbbbb/meshnology-web-flasher" target="_blank" rel="noreferrer">GitHub ↗</a>
      </nav>
    </header>

    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">OPEN SOURCE · LOCAL ONLY · NO LOGIN</p>
          <h1>Flash firmware<br><em>without the friction.</em></h1>
          <p class="lead">A 100% client-side flashing tool for <b>ESP32-S3</b> and <b>Nordic nRF52</b>. Your firmware never leaves the browser — WebUSB talks to your board directly.</p>
          <div class="cta-row">
            <button class="btn primary" id="cta-connect">Connect device →</button>
            <a class="btn ghost" href="#how">How it works</a>
          </div>
          <ul class="badges">
            <li>● No account</li>
            <li>● No upload</li>
            <li>● No telemetry</li>
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
            <h2>Connect your board</h2>
            <span id="status" class="badge warn">Disconnected</span>
          </div>
          <p>Use Chrome or Edge. WebUSB will prompt you to pick a device — grant the permission to continue.</p>
          <button id="connect" class="btn primary full">Connect USB device <span>→</span></button>
          <div id="deviceInfo" class="device-info hidden"></div>
        </div>

        <div class="card firmware">
          <div class="card-head">
            <span class="step">02</span>
            <h2>Pick your firmware</h2>
          </div>
          <div class="tabs">
            <button data-mode="single" class="tab active">Single merged .bin</button>
            <button data-mode="multi" class="tab">Multiple files + offsets</button>
          </div>
          <div id="drop" class="drop">
            <div class="upload-icon">↑</div>
            <b>Drop .bin files here</b>
            <span>or <label for="fileInput">browse from your computer</label></span>
            <input id="fileInput" type="file" accept=".bin,application/octet-stream" multiple hidden />
          </div>
          <div id="segments" class="segments"></div>
        </div>
      </section>

      <section class="card flash">
        <div class="card-head">
          <span class="step">03</span>
          <h2>Flash</h2>
          <span id="privacy">● Local processing</span>
        </div>
        <div class="flash-row">
          <div class="flash-info">
            <p id="summary">Add a firmware file to begin.</p>
            <div class="progress"><i id="bar"></i></div>
            <small id="log">Waiting for action…</small>
          </div>
          <button id="flash" class="btn dark" disabled>Start flashing <span>→</span></button>
        </div>
      </section>

      <div class="notice">
        ⚠ <span>Do not disconnect USB during flashing. If your board is not detected, hold the <b>BOOT</b> button while plugging it in.</span>
      </div>
    </main>

    <footer id="docs">
      <span>Meshnology Web Flasher · v0.1.0</span>
      <span>Firmware never leaves this device · MIT License</span>
    </footer>
  </div>
`;

const status = document.querySelector('#status')!;
const info = document.querySelector('#deviceInfo')!;
const log = document.querySelector('#log')!;
const bar = document.querySelector<HTMLDivElement>('#bar')!;
const summary = document.querySelector('#summary')!;
const flashBtn = document.querySelector<HTMLButtonElement>('#flash')!;
const drop = document.querySelector('#drop')!;
const list = document.querySelector('#segments')!;
const cta = document.querySelector<HTMLButtonElement>('#cta-connect')!;

function render() {
  list.innerHTML = segments.map((s,i)=>`<div class="file-row"><span class="file-icon">▣</span><div><b>${s.name}</b><small>${formatBytes(s.size)}${mode==='multi' ? ` · offset <input data-offset="${i}" value="0x${s.offset.toString(16).padStart(4,'0')}" />` : ''}</small></div><button data-remove="${i}" aria-label="Remove">×</button></div>`).join('');
  list.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(b=>b.onclick=()=>{segments.splice(Number(b.dataset.remove),1);render();});
  list.querySelectorAll<HTMLInputElement>('[data-offset]').forEach(input=>input.onchange=()=>{ const i=Number(input.dataset.offset); segments[i].offset=parseInt(input.value,16)||0; render(); });
  summary.textContent = segments.length ? `${segments.length} file${segments.length>1?'s':''} · ${formatBytes(segments.reduce((n,s)=>n+s.size,0))}` : 'Add a firmware file to begin.';
  flashBtn.disabled = !segments.length;
}
function formatBytes(n:number){return n<1024?`${n} B`:`${(n/1024/1024).toFixed(2)} MB`;}
async function addFiles(files: FileList|File[]){ for(const file of Array.from(files)){if(!file.name.toLowerCase().endsWith('.bin'))continue; segments.push({name:file.name,size:file.size,offset:mode==='single'?0:0x10000,file});} render(); }

document.querySelector('#fileInput')!.addEventListener('change',e=>addFiles((e.target as HTMLInputElement).files||[]));
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag');});
drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
drop.addEventListener('drop',e=>{const de=e as DragEvent; de.preventDefault();drop.classList.remove('drag'); if(de.dataTransfer) addFiles(de.dataTransfer.files);});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(tab=>tab.onclick=()=>{mode=tab.dataset.mode as any; document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));tab.classList.add('active');render();});

async function doConnect(){
  const support=detectBrowserSupport(navigator as any);
  if(!support.webUsb){status.textContent='Unsupported';status.className='badge error';log.textContent='Please use the latest Chrome or Edge.';return;}
  try {
    connected = await (navigator as any).usb.requestDevice({filters:[]});
    status.textContent='Connected';status.className='badge ok';
    info.textContent = `${connected.productName||'USB device'} · ${connected.serialNumber||'Authorized'}`;
    info.classList.remove('hidden');
    log.textContent='USB device authorized. Ready to flash.';
  } catch { log.textContent='Device selection cancelled.'; }
}
document.querySelector('#connect')!.addEventListener('click', doConnect);
cta.addEventListener('click', ()=>{ document.querySelector('#how')?.scrollIntoView({behavior:'smooth'}); doConnect(); });

flashBtn.addEventListener('click', async ()=>{
  const errors = validateSegments(segments);
  if(errors.length){ log.textContent = errors.join(' · '); return; }
  if(!connected){ log.textContent = 'Connect a USB device first.'; return; }
  flashBtn.disabled = true; bar.style.width = '0%';
  log.textContent = 'Preparing firmware locally…';
  for(let i=1;i<=20;i++){ await new Promise(r=>setTimeout(r,35)); bar.style.width = `${i*5}%`; }
  log.textContent = 'USB device connected. ESP32-S3 / nRF52 bootloader adapter not configured yet.';
  flashBtn.disabled = false;
});

render();
