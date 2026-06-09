const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TEST_USER_ID = 'Utest_liff_playwright_001';
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz9sfkqPCXXDQWSaHeTokthDbV_V0avhjBzfUhIatMoBTgSQs3HpE0yozoB3Wkw_WM_/exec';

async function runTest() {
  const browser = await chromium.launch({ headless: false, slowMo: 150 });
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
        body: JSON.stringify([{
          name: 'テストイベント', resultSheetName: 'テスト_当落',
          eventDate: '2026/07/01', closingDate: '2026/06/25',
          eventTime: '10:00〜16:00', venue: '渋谷テニスコート',
          coachName: '田中コーチ', description: 'テスト用イベントです'
        }])
      });
    } else if (method === 'GET' && url.includes('action=getMember')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    } else if (method === 'POST') {
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

  // イベント詳細が表示されるか確認
  const evName = await page.textContent('.ev-name').catch(() => '');
  results.push(evName.includes('テストイベント') ? '✅ イベント名表示: OK' : `❌ イベント名: "${evName}"`);

  const evMeta = await page.textContent('.ev-meta').catch(() => '');
  results.push(evMeta.includes('田中コーチ') && evMeta.includes('10:00') ? '✅ イベント詳細（コーチ・時間）表示: OK' : `❌ イベント詳細: "${evMeta}"`);

  // --- テスト1: 未入力で送信 → バリデーションエラー ---
  await page.click('#sbtn');
  await page.waitForTimeout(500);
  const errShown = await page.evaluate(() => {
    const el = document.getElementById('gerr');
    return el && el.style.display === 'block';
  });
  const errText = await page.textContent('#gerr').catch(() => '');
  results.push(errShown && errText.includes('お名前')
    ? '✅ バリデーション（未入力）: OK'
    : `❌ バリデーション: display=${await page.evaluate(() => document.getElementById('gerr')?.style.display)}, text="${errText}"`);

  // --- プロフィール入力（参加者1） ---
  await page.fill('#fN_1', '田中');
  await page.fill('#gN_1', '太郎');
  await page.fill('#fK_1', 'タナカ');
  await page.fill('#gK_1', 'タロウ');
  await page.fill('#age_1', '35');
  await page.fill('#email_1', 'test@example.com');
  await page.fill('#phone_1', '09012345678');
  await page.check('input[name="gnd_1"][value="男性"]');
  await page.check('input[name="lv_1"][value="中級"]');
  await page.check('input[name="freq_1"][value="週1回（土日祝が多い）"]');
  await page.check('input[name="hist_1"][value="3〜5年"]');
  await page.check('input[name="area_1"][value="東京"]');
  await page.check('input[name="env_1"][value="テニス仲間とコートを借りる"]');
  results.push('✅ プロフィール入力（参加者1）: OK');

  // --- 年齢18歳以下で緊急連絡先必須チェック ---
  await page.fill('#age_1', '16');
  await page.dispatchEvent('#age_1', 'change');
  await page.waitForTimeout(300);
  const emergencyLabel = await page.textContent('#emergencyFg_1 .fl').catch(() => '');
  results.push(emergencyLabel.includes('*') ? '✅ 18歳以下で緊急連絡先必須マーク: OK' : `❌ 緊急連絡先ラベル: "${emergencyLabel}"`);
  await page.fill('#age_1', '35');
  await page.dispatchEvent('#age_1', 'change');

  // --- その他テキスト入力の表示テスト ---
  await page.check('input[name="area_1"][value="その他"]');
  await page.waitForTimeout(200);
  const otherWrapVisible = await page.isVisible('#areaOtherWrap_1');
  results.push(otherWrapVisible ? '✅ 地域「その他」テキスト入力表示: OK' : '❌ 地域「その他」テキスト入力が表示されない');
  await page.fill('#areaOtherText_1', '北海道');
  await page.uncheck('input[name="area_1"][value="その他"]');

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

  // --- 利用規約のスクロールで同意チェックが有効化 ---
  const tosDisabledBefore = await page.evaluate(() => document.getElementById('tos').disabled);
  // スクロールを強制実行
  await page.evaluate(() => {
    const box = document.getElementById('tosBox');
    box.scrollTop = box.scrollHeight;
    box.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);
  const tosDisabledAfter = await page.evaluate(() => document.getElementById('tos').disabled);
  results.push(!tosDisabledAfter ? '✅ スクロール後に規約チェック有効化: OK' : '❌ スクロール後もチェック無効のまま');

  // 規約同意・メディア同意
  await page.check('#tos');
  await page.check('#mediaCons');

  // --- フォーム送信 ---
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
      ? '✅ イベント選択データ送信: OK' : '❌ イベント選択なし');
    results.push(Array.isArray(payload.additionalParticipants)
      ? '✅ additionalParticipants配列: OK（' + payload.additionalParticipants.length + '名）' : '❌ additionalParticipants未定義');
  }

  // 成功画面確認
  await page.waitForTimeout(500);
  const successText = await page.textContent('.st').catch(() => '');
  results.push(successText.includes('応募') ? `✅ 成功画面: OK（"${successText}"）` : `❌ 成功画面: "${successText}"`);

  await browser.close();

  console.log('\n===== LIFFフォームテスト結果 =====');
  results.forEach(r => console.log(r));
  const failCount = results.filter(r => r.startsWith('❌')).length;
  if (failCount > 0) {
    console.log(`\n⚠️ ${failCount}件の失敗あり`);
    process.exit(1);
  } else {
    console.log('\n✅ 全テスト通過');
  }
}

runTest().catch(err => {
  console.error('テスト失敗:', err.message);
  process.exit(1);
});
