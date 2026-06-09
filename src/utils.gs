// 紛らわしい文字（O・0・I・1）を除いた英数字8桁の受付コードを生成
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// スプレッドシートのシートを名前で取得
function getSheet(name) {
  const ss = SpreadsheetApp.openById(getProp('SPREADSHEET_ID'));
  return ss.getSheetByName(name);
}

// 設定シートの全イベント行を返す（1行目はヘッダーのためスキップ）
// 戻り値: [{ name, eventDate, closingDate, appSheetName, resultSheetName, winMsg, loseMsg }, ...]
function getAllEvents() {
  const sheet = getSheet(SHEET.CONFIG);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const events = [];
  for (let i = 1; i < data.length; i++) {
    const name = String(data[i][0]).trim();
    const eventDate = data[i][1] ? new Date(data[i][1]) : null;
    const closingDate = data[i][2] ? new Date(data[i][2]) : null;
    const appSheetName = String(data[i][3]).trim();
    const winMsg = String(data[i][4] || '').trim();  // E列：当選メッセージ
    const loseMsg = String(data[i][5] || '').trim(); // F列：落選メッセージ
    if (!name || !appSheetName) continue;
    const resultSheetName = appSheetName.replace('_応募', '_当落');
    events.push({ name, eventDate, closingDate, appSheetName, resultSheetName, winMsg, loseMsg });
  }
  return events;
}

// アクション履歴シートに1行追加する
function logAction(userId, actionType, eventId, detail) {
  try {
    const sheet = getSheet(SHEET.ACTION_LOG);
    if (!sheet) return;
    sheet.appendRow([new Date(), userId || '', actionType, eventId || '', detail || '']);
  } catch (err) {
    Logger.log('logAction error: ' + err.toString());
  }
}

// LINE APIへのPOSTリクエスト共通処理
function linePost(endpoint, payload) {
  const token = getProp('LINE_CHANNEL_ACCESS_TOKEN');
  const res = UrlFetchApp.fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const result = JSON.parse(res.getContentText());
  if (result.message) {
    Logger.log(`LINE API error [${endpoint}]: ${result.message}`);
  }
  return result;
}

// リプライ送信（Webhookで受信したメッセージへの返信）
function replyMessage(replyToken, text) {
  return linePost('reply', {
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

// プッシュ送信（特定のUser IDまたはグループIDへ送信）
function pushMessage(to, text) {
  return linePost('push', {
    to,
    messages: [{ type: 'text', text }],
  });
}

// スタッフグループへ通知（STAFF_GROUP_IDが未設定の場合はスキップ）
function notifyStaff(text) {
  const groupId = getProp('STAFF_GROUP_ID');
  if (!groupId) {
    Logger.log('STAFF_GROUP_ID未設定のためスタッフ通知をスキップ: ' + text);
    return;
  }
  return pushMessage(groupId, text);
}

// アラートメールを ALERT_EMAIL 宛に送信
function sendAlertEmail(subject, body) {
  const email = getProp('ALERT_EMAIL');
  if (!email) {
    Logger.log('ALERT_EMAIL未設定のためメール送信をスキップ: ' + subject);
    return;
  }
  GmailApp.sendEmail(email, subject, body);
}
