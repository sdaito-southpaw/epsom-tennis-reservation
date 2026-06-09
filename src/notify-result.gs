// 対象イベントの当落シートを開いた状態でメニューから呼び出す。
// 未送信の行に当落通知を一括送信する。
function sendResults() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const sheetName = sheet.getName();

  if (!sheetName.endsWith('_当落')) {
    SpreadsheetApp.getUi().alert(
      '対象の当落シートを開いた状態でこの機能を実行してください。\n' +
      '（シート名が「_当落」で終わるシートを選択してください）'
    );
    return;
  }

  const { winCount, loseCount } = sendResultsCore(sheet);

  if (winCount + loseCount === 0) {
    SpreadsheetApp.getUi().alert(
      '送信対象がありません。\n' +
      '「当選」または「落選」が入力されていて、未送信の行があるか確認してください。'
    );
    return;
  }

  const eventName = sheetName.replace('_当落', '');
  notifyStaff(`📨 当落通知 送信完了\n${eventName}\n当選: ${winCount}名 / 落選: ${loseCount}名`);
  SpreadsheetApp.getUi().alert(`送信完了\n当選: ${winCount}名 / 落選: ${loseCount}名`);
}

// メニューからもダッシュボードからも呼び出せる送信処理の共通実装
function sendResultsCore(sheet) {
  const sheetName = sheet.getName();
  const messages = getResultMessages(sheetName);
  const data = sheet.getDataRange().getValues();
  let winCount = 0;
  let loseCount = 0;

  for (let i = 1; i < data.length; i++) {
    const userId = data[i][1]; // B列：User ID
    const result = data[i][2]; // C列：結果
    const sent   = data[i][3]; // D列：送信済みフラグ

    if (sent === '済') continue;
    if (result !== '当選' && result !== '落選') continue;
    if (!userId) continue;

    const message = result === '当選' ? messages.win : messages.lose;
    pushMessage(userId, message);

    sheet.getRange(i + 1, 4).setValue('済');
    sheet.getRange(i + 1, 5).setValue(new Date());

    logAction(userId, result === '当選' ? '当落通知_当選' : '当落通知_落選', sheetName.replace('_当落', ''), '');

    if (result === '当選') winCount++;
    else loseCount++;

    if ((winCount + loseCount) % 10 === 0) Utilities.sleep(1000);
  }

  return { winCount, loseCount };
}

// 設定シートのE列（当選文）・F列（落選文）からメッセージを取得する。
// 設定シートに文が入っていない場合はデフォルト文を返す。
function getResultMessages(resultSheetName) {
  const appSheetName = resultSheetName.replace('_当落', '_応募');
  const configSheet = getSheet(SHEET.CONFIG);

  if (configSheet) {
    const data = configSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][3]).trim() === appSheetName) {
        const winMsg = String(data[i][4]).trim();
        const loseMsg = String(data[i][5]).trim();
        return {
          win:  winMsg  || defaultWinMessage(),
          lose: loseMsg || defaultLoseMessage(),
        };
      }
    }
  }

  return { win: defaultWinMessage(), lose: defaultLoseMessage() };
}

function defaultWinMessage() {
  return (
    `【当選のお知らせ】\n` +
    `このたびはイベントへの参加が確定しました！\n` +
    `詳細は別途ご連絡します。\n` +
    `ご参加をお待ちしております。`
  );
}

function defaultLoseMessage() {
  return (
    `【落選のお知らせ】\n` +
    `今回は定員に達したため、ご参加いただけませんでした。\n` +
    `ご応募いただきありがとうございました。\n` +
    `またのご応募をお待ちしています。`
  );
}

// スプレッドシートを開いたときにメニューを追加
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('イベント管理')
    .addItem('当落通知を送信', 'sendResults')
    .addItem('新しいイベントをセットアップ', 'setupNewEvent')
    .addToUi();
}
