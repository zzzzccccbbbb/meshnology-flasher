const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Users\\97648\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  const requests = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('request', r => requests.push(r.url()));
  const url = process.argv[2] || 'https://meshnology-web-flasher.pages.dev/';
  console.log('Visiting', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  const heroH1 = (await page.locator('h1').first().textContent())?.replace(/\s+/g,' ').trim();
  const logoSrc = await page.locator('header .brand img').getAttribute('src');
  const logoStatus = logoSrc ? await page.evaluate(async (s) => {
    const r = await fetch(s, { method: 'HEAD' });
    return r.status;
  }, new URL(logoSrc, page.url()).toString()) : 'no-logo';
  const switchVisible = await page.locator('.lang-switch').isVisible();
  const enActive = await page.locator('.lang-btn[data-lang="en"]').getAttribute('aria-selected');
  const eyebrowEN = (await page.locator('#eyebrow').textContent())?.trim();
  await page.locator('.lang-btn[data-lang="zh"]').click();
  await page.waitForTimeout(300);
  const eyebrowZH = (await page.locator('#eyebrow').textContent())?.trim();
  const zhActive = await page.locator('.lang-btn[data-lang="zh"]').getAttribute('aria-selected');
  await page.screenshot({ path: 'pages-en.png', fullPage: true });
  await page.locator('.lang-btn[data-lang="en"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'pages-zh.png', fullPage: true });
  const externalHosts = [...new Set(requests.map(u => { try { return new URL(u).host; } catch { return ''; } }).filter(h => h && !h.endsWith('pages.dev')))];
  await browser.close();
  console.log(JSON.stringify({
    url, title, heroH1, logoSrc, logoStatus, switchVisible, enActive, zhActive,
    eyebrowEN, eyebrowZH,
    pageErrors: errs,
    externalHosts,
  }, null, 2));
})().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
