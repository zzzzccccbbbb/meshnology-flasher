const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Users\\97648\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 600, height: 200 } });
  await page.setContent(`<html><body style="margin:0;background:#fff"><img src="file:///D:/Download/meshnology-web-flasher/dist/logo.svg" style="width:540px;height:auto"></body></html>`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'logo-new.png', clip: { x: 0, y: 0, width: 600, height: 160 } });
  await browser.close();
  console.log('OK');
})().catch(e => { console.error(e); process.exit(1); });
