// LINE Webhookのエントリポイント
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    for (const event of body.events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        if (text === '応募') {
          handleOubo(event);
        } else if (text === '応募状況') {
          handleOuboStatus(event);
        }
      }
    }
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
  }

  // LINEには必ず200 OKを返す
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 「応募」メッセージを受信した時の処理
// LIFF_IDが設定されていればLIFF URLを返信、未設定なら受付コードを返信
function handleOubo(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const liffId = getProp('LIFF_ID');
  const liffUrl = liffId ? `https://liff.line.me/${liffId}` : null;

  const sheet = getSheet(SHEET.MEMBERS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === userId) {
      // 2回目以降
      if (liffUrl) {
        replyMessage(replyToken,
          `こちらのフォームから応募・プロフィール更新ができます！\n\n${liffUrl}`
        );
      } else {
        const existingCode = data[i][2];
        replyMessage(replyToken,
          `すでに受付コードが発行されています。\n\n【 ${existingCode} 】\n\n` +
          `Googleフォームの「受付コード」欄にこのコードを入力してください。`
        );
      }
      logAction(userId, liffUrl ? 'LIFF URL送信' : '既存コード再送', '', '');
      return;
    }
  }

  // 新規：受付コードを生成して会員マスタに保存
  const code = generateCode();
  sheet.appendRow([new Date(), userId, code, '', '', '']);

  if (liffUrl) {
    replyMessage(replyToken,
      `ご応募ありがとうございます！\n\nこちらのフォームから応募してください。\n\n${liffUrl}`
    );
    logAction(userId, 'LIFF URL送信（新規）', '', code);
  } else {
    replyMessage(replyToken,
      `ご応募ありがとうございます！\n` +
      `あなたの受付コードは\n\n【 ${code} 】\n\nです。\n` +
      `Googleフォームの「受付コード」欄にこのコードを入力してください。`
    );
    logAction(userId, '受付コード発行', '', code);
  }
}

// 「応募状況」メッセージを受信した時の処理
// 設定シートの全イベントを走査し、開催日が今日以降のものをすべて1通にまとめて返信する
function handleOuboStatus(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const allEvents = getAllEvents();
  const lines = [];

  for (const ev of allEvents) {
    // 開催日が過去のイベントは表示しない
    if (ev.eventDate) {
      const d = new Date(ev.eventDate);
      d.setHours(0, 0, 0, 0);
      if (d < today) continue;
    }

    let status = '';

    // 当落シートB列でUser IDを検索
    const resultSheet = getSheet(ev.resultSheetName);
    if (resultSheet) {
      const resultData = resultSheet.getDataRange().getValues();
      for (let i = 1; i < resultData.length; i++) {
        if (resultData[i][1] === userId) {
          const result = resultData[i][2];
          if (result === '当選') {
            status = '応募済み（当選）';
          } else if (result === '落選') {
            status = '応募済み（落選）';
          }
          break;
        }
      }
    }

    // 当落シートになければ応募シートS列（インデックス18）でUser IDを検索
    if (!status) {
      const appSheet = getSheet(ev.appSheetName);
      if (appSheet) {
        const appData = appSheet.getDataRange().getValues();
        for (let i = 1; i < appData.length; i++) {
          if (appData[i][18] === userId) {
            status = '応募済み（当落発表前）';
            break;
          }
        }
      }
    }

    // どこにも存在しない場合は募集終了日で期間中か終了かを判定
    if (!status) {
      if (ev.closingDate) {
        const closing = new Date(ev.closingDate);
        closing.setHours(0, 0, 0, 0);
        status = closing >= today ? '未応募（応募期間中）' : '未応募（応募期間終了）';
      } else {
        status = '未応募';
      }
    }

    lines.push(`【${ev.name}】\n${status}`);
  }

  if (lines.length === 0) {
    replyMessage(replyToken, '現在参加受付中のイベントはありません。');
  } else {
    replyMessage(replyToken, lines.join('\n\n'));
  }

  logAction(userId, '応募状況照会', '', '');
}
