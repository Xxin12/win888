import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:5178/#/market', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 2500));
const headerText = await page.evaluate(() => {
  const panel = document.querySelector('.panel');
  return panel ? panel.innerText.split('\n')[0] : '(no panel)';
});
console.log('HEADER_LINE:', headerText.replace(/\s+/g,' ').trim());
await browser.close();
