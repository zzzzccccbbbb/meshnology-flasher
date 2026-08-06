const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:\\\\Users\\\\97648\\\\AppData\\\\Local\\\\ms-playwright\\\\chromium-1223\\\\chrome-win64\\\\chrome.exe' });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
  const title = await page.title();
  const eyebrowEN = (await page.locator('#eyebrow').textContent())?.trim();
  const ctaEN = (await page.locator('#cta-connect').textContent())?.trim();
  const badgesEN = await page.locator('#badges li').allTextContents();
  const switchVisible = await page.locator('.lang-switch').isVisible();
  const enActive = await page.locator('.lang-btn[data-lang="en"]').getAttribute('aria-selected');
  await page.locator('.lang-btn[data-lang="zh"]').click();
  await page.waitForTimeout(300);
  const eyebrowZH = (await page.locator('#eyebrow').textContent())?.trim();
  const ctaZH = (await page.locator('#cta-connect').textContent())?.trim();
  const badgesZH = await page.locator('#badges li').allTextContents();
  const zhActive = await page.locator('.lang-btn[data-lang="zh"]').getAttribute('aria-selected');
  await page.locator('.lang-btn[data-lang="en"]').click();
  await page.waitForTimeout(300);
  const eyebrowEN2 = (await page.locator('#eyebrow').textContent())?.trim();
  const enActive2 = await page.locator('.lang-btn[data-lang="en"]').getAttribute('aria-selected');
  await page.screenshot({ path: 'verify-en.png', fullPage: true });
  await page.locator('.lang-btn[data-lang="zh"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'verify-zh.png', fullPage: true });
  await browser.close();
  console.log(JSON.stringify({
    title, switchVisible, enActive, zhActive, enActive2,
    eyebrowEN, eyebrowZH, eyebrowEN2, ctaEN, ctaZH, badgesEN, badgesZH,
    pageErrors: errs,
  }, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

