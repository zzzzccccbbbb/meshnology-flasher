const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Users\\97648\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
  await page.goto('https://meshnology-flasher.pages.dev/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'site-en.png', clip: { x: 0, y: 0, width: 1280, height: 200 } });
  await browser.close();
  console.log('OK');
})().catch(e => { console.error(e); process.exit(1); });
