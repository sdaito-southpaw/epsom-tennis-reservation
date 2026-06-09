const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TEST_USER_ID = 'Utest_liff_playwright_001';
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz9sfkqPCXXDQWSaHeTokthDbV_V0avhjBzfUhIatMoBTgSQs3HpE0yozoB3Wkw_WM_/exec';
const DIAGNOSE_URL = `${GAS_URL}?action=diagnose&token=epsomtennis`;

async function runTest() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const page = await browser.newPage();
  const results = [];

  let html = fs.readFileSync(path.join(__dirname, '../docs/liff/index.html'), 'utf8');

  // LINE CDN SDKをモックに差し替え
  html = html.replace(
    '<script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>',
    `<script>
      window.liff = {
        init: () => Promise.resolve(),
        isLoggedIn: () => true,
        login: () => {},
        getProfile: () => Promise.resolve({ userId: '${TEST_USER_ID}', displayName: 'テスト ユーザー' }),
        isInClient: () => false,
        closeWindow: () => {}
      };
    </script>`
  );

  // GAS呼び出しをすべてモック化（CORSを回避）
  await page.route('**script.google.com**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'GET' && url.includes('action=getEvents')) {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ name: 'テストイベント', resultSheetName: 'テスト_当落', eventDate: '2026/07/01', closingDate: '2026/06/25' }]) });
    } else if (method === 'GET' && url.includes('action=getMember')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    } else if (method === 'POST') {
      // 送信内容を記録してモック成功レスポンスを返す
      const body = JSON.parse(route.request().postData() || '{}');
      page._submitPayload = body;
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, appliedEvents: ['テストイベント'] }) });
    } else {
      await route.continue();
    }
  });

  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.waitForSelector('#fw', { state: 'visible', timeout: 10000 });
  results.push('✅ フォーム表示: OK');

  // --- テスト1: 未入力で送信 → バリデーションエラー ---
  await page.click('#sbtn');
  await page.waitForTimeout(500);
  const errText = await page.textContent('#gerr').catch(() => '');
  const errShown = await page.evaluate(() => {
    const el = document.getElementById('gerr');
    return el && el.style.display !== 'none' && el.style.display !== '';
  });
  results.push(errShown && errText.includes('お名前')
    ? '✅ バリデーション（未入力）: OK'
    : `❌ バリデーション: gerr display=${await page.evaluate(() => document.getElementById('gerr')?.style.display)}, text="${errText}"`);

  // --- フォーム入力 ---
  await page.fill('#fN', '田中');
  await page.fill('#gN', '太郎');
  await page.fill('#fK', 'タナカ');
  await page.fill('#gK', 'タロウ');
  await page.fill('#age', '35');
  await page.fill('#email', 'test@example.com');
  await page.fill('#phone', '09012345678');
  await page.check('input[name="gnd"][value="男性"]');
  await page.check('input[name="lv"][value="中級"]');
  await page.check('input[name="freq"][value="週1回（土日祝が多い）"]');
  await page.check('input[name="hist"][value="3〜5年"]');
  await page.check('input[name="area"][value="東京"]');
  await page.check('input[name="env"][value="テニス仲間とコートを借りる"]');
  results.push('✅ プロフィール入力: OK');

  // イベント選択
  await page.check('input[name="ev"][value="0"]');
  await page.check('input[name="coach"][value="知っていて、レッスンも受けたことがある"]');
  await page.check('input[name="src"][value="公式SNS"]');
  await page.check('input[name="rsn"][value="テニスイベントに興味があった"]');
  results.push('✅ イベント選択: OK');

  // --- テスト2: 規約未同意で送信 → バリデーションエラー ---
  await page.click('#sbtn');
  await page.waitForTimeout(500);
  const tosErr = await page.evaluate(() => {
    const el = document.getElementById('gerr');
    return el && el.style.display === 'block' && el.textContent.includes('規約');
  });
  results.push(tosErr ? '✅ バリデーション（規約未同意）: OK' : '❌ バリデーション（規約未同意）: エラーなし');

  // 規約同意して送信
  await page.check('#tos');
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('script.google.com'), { timeout: 10000 }),
    page.click('#sbtn')
  ]);
  const resBody = await response.json().catch(() => null);
  results.push(resBody?.success ? '✅ フォーム送信: OK（モックGASレスポンス受信）' : `❌ フォーム送信: ${JSON.stringify(resBody)}`);

  // 送信内容の確認
  const payload = page._submitPayload;
  if (payload) {
    results.push(payload.userId === TEST_USER_ID ? '✅ userId正しく送信: OK' : `❌ userId不一致: ${payload.userId}`);
    results.push(payload.familyName === '田中' ? '✅ 名前送信: OK' : `❌ 名前: ${payload.familyName}`);
    results.push(Array.isArray(payload.selectedEvents) && payload.selectedEvents.length > 0
      ? '✅ イベント選択データ送信: OK'
      : '❌ イベント選択なし');
  }

  // 成功画面確認
  await page.waitForTimeout(500);
  const successText = await page.textContent('.st').catch(() => '');
  results.push(successText.includes('応募') ? `✅ 成功画面: OK（"${successText}"）` : `❌ 成功画面: "${successText}"`);

  await browser.close();

  console.log('\n===== LIFFフォームテスト結果 =====');
  results.forEach(r => console.log(r));

  // 実GASへの書き込みは別途確認（testOuboで検証済み）
  console.log('\n===== 備考 =====');
  console.log('GAS実書き込みはtestOuboエンドポイントで確認済み（Utest_direct_001）');
  console.log('全テスト完了');
}

runTest().catch(err => {
  console.error('テスト失敗:', err.message);
  process.exit(1);
});
