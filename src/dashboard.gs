// 管理ダッシュボード + LIFF向けJSON API
// GASのWebアプリとしてデプロイ（実行ユーザー：自分、アクセス権：全員）
function doGet(e) {
  const page   = e && e.parameter && e.parameter.page;
  const action = e && e.parameter && e.parameter.action;
  const token  = e && e.parameter && e.parameter.token;

  // LIFF向けJSON API（GitHub PagesのHTMLからfetch()で呼び出す）
  if (action === 'getEvents') {
    return liffApiResponse(getLiffEventsJson());
  }
  if (action === 'getMember') {
    const userId = e && e.parameter && e.parameter.userId;
    return liffApiResponse(getMemberData(userId));
  }
  // 診断エンドポイント（テスト用）
  if (action === 'diagnose' && token === getProp('DASHBOARD_TOKEN')) {
    return liffApiResponse(runDiagnose());
  }
  // LINE push送信テスト（テスト用）
  if (action === 'testPush' && token === getProp('DASHBOARD_TOKEN')) {
    const targetUserId = e.parameter.userId;
    if (!targetUserId) return liffApiResponse({ ok: false, error: 'userId required' });
    try {
      const result = pushMessage(targetUserId, '[テスト送信] GASからのLINE送信テストです。このメッセージが届いていれば正常です。');
      return liffApiResponse({ ok: true, lineResult: result });
    } catch (err) {
      return liffApiResponse({ ok: false, error: err.toString() });
    }
  }
  // Webhookの応募処理を直接テスト（テスト用）
  if (action === 'testOubo' && token === getProp('DASHBOARD_TOKEN')) {
    const testUserId = (e.parameter.userId || 'Utest_direct_001');
    const fakeEvent = {
      source: { userId: testUserId },
      replyToken: 'test_token_skip_reply'
    };
    try {
      handleOubo(fakeEvent);
      return liffApiResponse({ ok: true, userId: testUserId });
    } catch (err) {
      return liffApiResponse({ ok: false, error: err.toString() });
    }
  }

  // 旧LIFFページ（後方互換のため残す）
  if (page === 'liff') {
    return getLiffPage();
  }

  // ダッシュボードはDASHBOARD_TOKENで保護
  const dashboardToken = getProp('DASHBOARD_TOKEN');
  if (!dashboardToken || token !== dashboardToken) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;text-align:center;padding:80px 20px">' +
      '<h2>⛔ アクセス権限がありません</h2>' +
      '<p style="color:#888">正しいURLでアクセスしてください。</p></div>'
    ).setTitle('Access Denied');
  }

  return HtmlService.createHtmlOutput(getDashboardHtml())
    .setTitle('イベント管理ダッシュボード')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// LIFF向けフォーム送信を受け付けるPOSTエンドポイント
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'submitLiff') {
      const result = submitLiffApplication(data);
      return liffApiResponse(result);
    }
    return liffApiResponse({ success: false, error: '不明なアクションです。' });
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return liffApiResponse({ success: false, error: err.toString() });
  }
}

// JSON APIレスポンスを生成する
function liffApiResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// LIFF向けイベント一覧を返す（募集終了日が今日以降のもの）
function getLiffEventsJson() {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return getAllEvents()
      .filter(ev => !ev.closingDate || ev.closingDate >= today)
      .map(ev => ({
        name:            ev.name,
        resultSheetName: ev.resultSheetName,
        eventDate:       ev.eventDate   ? Utilities.formatDate(ev.eventDate,   'Asia/Tokyo', 'yyyy/MM/dd') : '',
        closingDate:     ev.closingDate ? Utilities.formatDate(ev.closingDate, 'Asia/Tokyo', 'yyyy/MM/dd') : '',
      }));
  } catch (err) {
    Logger.log('getLiffEventsJson error: ' + err.toString());
    return [];
  }
}

// ===== クライアントから呼び出すサーバー関数 =====

// 全イベントの一覧と統計情報を返す
function getEventsData() {
  const events = getAllEvents();
  return events.map(ev => {
    const appSheet = getSheet(ev.appSheetName);
    const resultSheet = getSheet(ev.resultSheetName);

    // 応募数は当落シートを基準にカウント（Google FormとLIFF両方を含む）
    const appCount = resultSheet && resultSheet.getLastRow() > 1 ? resultSheet.getLastRow() - 1 : 0;

    let winCount = 0, loseCount = 0, sentCount = 0, pendingCount = 0;
    if (resultSheet && resultSheet.getLastRow() > 1) {
      const data = resultSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const result = data[i][2];
        const sent = data[i][3];
        if (result === '当選') winCount++;
        if (result === '落選') loseCount++;
        if (sent === '済') sentCount++;
        if ((result === '当選' || result === '落選') && sent !== '済') pendingCount++;
      }
    }

    return {
      name: ev.name,
      eventDate: ev.eventDate ? Utilities.formatDate(ev.eventDate, 'Asia/Tokyo', 'yyyy/MM/dd') : '',
      closingDate: ev.closingDate ? Utilities.formatDate(ev.closingDate, 'Asia/Tokyo', 'yyyy/MM/dd') : '',
      appSheetName: ev.appSheetName,
      resultSheetName: ev.resultSheetName,
      appCount,
      winCount,
      loseCount,
      sentCount,
      pendingCount,
    };
  });
}

// 指定イベントの応募者一覧を返す（当落シートを基準に、Google FormとLIFF両方の応募を含む）
function getApplicants(appSheetName, resultSheetName) {
  const resultSheet = getSheet(resultSheetName);
  if (!resultSheet || resultSheet.getLastRow() <= 1) return [];

  // 応募シートから応募日時マップを作成（Google Form経由の応募）
  const appDateMap = {};
  const appSheet = getSheet(appSheetName);
  if (appSheet && appSheet.getLastRow() > 1) {
    const appData = appSheet.getDataRange().getValues();
    for (let i = 1; i < appData.length; i++) {
      const uid = String(appData[i][18] || ''); // S列
      if (uid && !appDateMap[uid]) {
        appDateMap[uid] = appData[i][0]
          ? Utilities.formatDate(new Date(appData[i][0]), 'Asia/Tokyo', 'MM/dd HH:mm')
          : '';
      }
    }
  }

  const data = resultSheet.getDataRange().getValues();
  const applicants = [];
  for (let i = 1; i < data.length; i++) {
    const userId = String(data[i][1] || '');
    if (!userId) continue;
    applicants.push({
      name:      String(data[i][0] || ''),
      userId,
      appliedAt: appDateMap[userId] || '',
      result:    String(data[i][2] || ''),
      sent:      String(data[i][3] || ''),
    });
  }
  return applicants;
}

// 当落シートの指定User IDの行のC列に当落を書き込む
function setResult(resultSheetName, userId, result) {
  if (result !== '当選' && result !== '落選') {
    return { success: false, error: '結果は「当選」または「落選」のみ指定できます。' };
  }
  const sheet = getSheet(resultSheetName);
  if (!sheet) return { success: false, error: 'シートが見つかりません。' };

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === userId) {
      sheet.getRange(i + 1, 3).setValue(result);
      return { success: true };
    }
  }
  return { success: false, error: '指定されたUser IDが見つかりません。' };
}

// ダッシュボードから当落通知を一括送信する（sendResultsCoreを呼び出す）
function sendResultsFromDashboard(resultSheetName) {
  const sheet = getSheet(resultSheetName);
  if (!sheet) return { success: false, error: 'シートが見つかりません。' };

  const { winCount, loseCount } = sendResultsCore(sheet);

  if (winCount + loseCount > 0) {
    const eventName = resultSheetName.replace('_当落', '');
    notifyStaff(`📨 当落通知 送信完了\n${eventName}\n当選: ${winCount}名 / 落選: ${loseCount}名`);
  }

  return { success: true, winCount, loseCount };
}

// ステータスで絞り込んだUser IDリストを返す
function getFilteredUsers(appSheetName, resultSheetName, status) {
  const membersSheet = getSheet(SHEET.MEMBERS);
  if (!membersSheet || membersSheet.getLastRow() <= 1) return [];

  // 応募済みUser IDのセットを構築
  const submittedSet = new Set();
  const appSheet = getSheet(appSheetName);
  if (appSheet && appSheet.getLastRow() > 1) {
    const appData = appSheet.getDataRange().getValues();
    for (let i = 1; i < appData.length; i++) {
      if (appData[i][18]) submittedSet.add(String(appData[i][18]));
    }
  }

  // 当落ステータスのマップを構築
  const resultMap = {};
  const resultSheet = getSheet(resultSheetName);
  if (resultSheet && resultSheet.getLastRow() > 1) {
    const resultData = resultSheet.getDataRange().getValues();
    for (let i = 1; i < resultData.length; i++) {
      resultMap[String(resultData[i][1])] = String(resultData[i][2] || '');
    }
  }

  const membersData = membersSheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < membersData.length; i++) {
    const userId = String(membersData[i][1]);
    const name = String(membersData[i][4] || membersData[i][2] || '（名前未取得）'); // E列（名前）優先、なければ受付コード
    const userResult = resultMap[userId] || '';
    const isSubmitted = submittedSet.has(userId);

    let match = false;
    if (status === '当選' && userResult === '当選') match = true;
    else if (status === '落選' && userResult === '落選') match = true;
    else if (status === '応募済み' && isSubmitted && !userResult) match = true;
    else if (status === '未応募' && !isSubmitted) match = true;

    if (match) result.push({ name, userId });
  }
  return result;
}

// 指定User IDリストに一括でメッセージを送信する
function sendBroadcast(userIds, message) {
  if (!message || !userIds || userIds.length === 0) {
    return { success: false, error: '送信先またはメッセージが指定されていません。' };
  }

  let count = 0;
  for (const userId of userIds) {
    pushMessage(userId, message);
    logAction(userId, '絞り込み送信', '', message.substring(0, 50));
    count++;
    if (count % 10 === 0) Utilities.sleep(1000);
  }

  notifyStaff(`📢 絞り込み送信完了\n${count}名に送信しました`);
  return { success: true, count };
}

// 会員マスタの全会員データを返す
function getMembersData() {
  const sheet = getSheet(SHEET.MEMBERS);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const data = sheet.getDataRange().getValues();
  const members = [];
  for (let i = 1; i < data.length; i++) {
    const userId = String(data[i][1] || '');
    if (!userId) continue;
    members.push({
      userId,
      name:          String(data[i][4]  || ''),
      furigana:      String(data[i][11] || ''),
      age:           String(data[i][6]  || ''),
      gender:        String(data[i][7]  || ''),
      tennisLevel:   String(data[i][8]  || ''),
      tennisFreq:    String(data[i][13] || ''),
      tennisHistory: String(data[i][14] || ''),
      tennisArea:    String(data[i][15] || ''),
      tennisEnv:     String(data[i][16] || ''),
      email:         String(data[i][9]  || ''),
      phone:         String(data[i][10] || ''),
      registeredAt: data[i][0] ? Utilities.formatDate(new Date(data[i][0]), 'Asia/Tokyo', 'yyyy/MM/dd') : '',
    });
  }
  return members;
}

// ===== HTMLの生成 =====

function getDashboardHtml() {
  return '<!DOCTYPE html>' +
'<html lang="ja">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>イベント管理ダッシュボード</title>' +
'<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">' +
'<style>' +
'body{font-size:14px;background:#f8f9fa}' +
'.event-card{cursor:pointer;transition:box-shadow .15s}' +
'.event-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.15)}' +
'.event-card.active{border-color:#0d6efd!important;background:#f0f4ff}' +
'.badge-pending{background:#ffc107;color:#000}' +
'.status-当選{color:#198754;font-weight:bold}' +
'.status-落選{color:#dc3545}' +
'.status-未処理{color:#6c757d}' +
'#spinner{display:none}' +
'</style>' +
'</head>' +
'<body>' +
'<div class="container-fluid py-3 px-4">' +
'<div class="d-flex align-items-center mb-3">' +
'<h5 class="mb-0 me-3">📋 イベント管理ダッシュボード</h5>' +
'<div id="spinner" class="spinner-border spinner-border-sm text-primary"></div>' +
'</div>' +

'<ul class="nav nav-tabs mb-3" id="mainTab" role="tablist">' +
'<li class="nav-item"><a class="nav-link active" href="#" id="tab-btn-events" onclick="showTab(\'events\');return false">イベント一覧</a></li>' +
'<li class="nav-item"><a class="nav-link" href="#" id="tab-btn-broadcast" onclick="showTab(\'broadcast\');return false">絞り込み送信</a></li>' +
'<li class="nav-item"><a class="nav-link" href="#" id="tab-btn-members" onclick="showTab(\'members\');return false">会員一覧</a></li>' +
'</ul>' +

'<!-- イベント一覧タブ -->' +
'<div id="tab-events">' +
'<div id="eventList" class="row g-2 mb-3"></div>' +
'<div id="applicantSection" style="display:none">' +
'<div class="d-flex align-items-center gap-2 mb-2">' +
'<h6 class="mb-0" id="applicantTitle"></h6>' +
'<button class="btn btn-success btn-sm" onclick="sendNotifications()">📨 当落通知を送信</button>' +
'<button class="btn btn-outline-secondary btn-sm" onclick="closeApplicants()">✕ 閉じる</button>' +
'</div>' +
'<div class="table-responsive">' +
'<table class="table table-sm table-hover bg-white">' +
'<thead class="table-light">' +
'<tr><th>お名前</th><th>応募日時</th><th>当落</th><th>通知</th><th>操作</th></tr>' +
'</thead>' +
'<tbody id="applicantBody"></tbody>' +
'</table>' +
'</div>' +
'</div>' +
'</div>' +

'<!-- 絞り込み送信タブ -->' +
'<div id="tab-broadcast" style="display:none">' +
'<div class="row g-3">' +
'<div class="col-md-4">' +
'<div class="card p-3">' +
'<div class="mb-2">' +
'<label class="form-label fw-bold">対象イベント</label>' +
'<select class="form-select" id="bcastEvent"><option value="">（選択してください）</option></select>' +
'</div>' +
'<div class="mb-2">' +
'<label class="form-label fw-bold">ステータスで絞り込み</label>' +
'<select class="form-select" id="bcastStatus">' +
'<option value="未応募">未応募</option>' +
'<option value="応募済み">応募済み</option>' +
'<option value="当選">当選</option>' +
'<option value="落選">落選</option>' +
'</select>' +
'</div>' +
'<button class="btn btn-outline-primary w-100 mb-2" onclick="loadBcastUsers()">対象者を確認</button>' +
'<div id="bcastUserList" class="border rounded p-2 bg-white" style="min-height:60px;max-height:200px;overflow-y:auto;font-size:12px;"></div>' +
'</div>' +
'</div>' +
'<div class="col-md-8">' +
'<div class="card p-3">' +
'<label class="form-label fw-bold">メッセージ</label>' +
'<textarea class="form-control mb-2" id="bcastMessage" rows="10" placeholder="送信するメッセージを入力してください"></textarea>' +
'<div class="d-flex align-items-center gap-2">' +
'<button class="btn btn-primary" onclick="execBroadcast()">📢 送信する</button>' +
'<span id="bcastResult" class="text-muted small"></span>' +
'</div>' +
'</div>' +
'</div>' +
'</div>' +
'</div>' +

'<!-- 会員一覧タブ -->' +
'<div id="tab-members" style="display:none">' +
'<div class="row g-3">' +
'<div class="col-md-4">' +
'<div class="card p-3">' +
'<div class="mb-2"><label class="form-label fw-bold">性別</label>' +
'<select class="form-select" id="mFilterGender"><option value="">全員</option><option value="男性">男性</option><option value="女性">女性</option></select></div>' +
'<div class="mb-2"><label class="form-label fw-bold">年齢</label>' +
'<div class="d-flex align-items-center gap-1">' +
'<input type="number" class="form-control" id="mFilterAgeMin" placeholder="下限" min="0">' +
'<span class="px-1">〜</span>' +
'<input type="number" class="form-control" id="mFilterAgeMax" placeholder="上限" min="0">' +
'</div></div>' +
'<div class="mb-2"><label class="form-label fw-bold">テニスレベル</label>' +
'<select class="form-select" id="mFilterLevel"><option value="">全員</option></select></div>' +
'<button class="btn btn-outline-primary w-100 mb-2" onclick="filterMembers()">対象者を確認</button>' +
'<div id="mTargetList" class="border rounded p-2 bg-white" style="min-height:60px;max-height:200px;overflow-y:auto;font-size:12px;"></div>' +
'</div></div>' +
'<div class="col-md-8">' +
'<div class="card p-3 mb-2">' +
'<label class="form-label fw-bold">メッセージ</label>' +
'<textarea class="form-control mb-2" id="mMessage" rows="6" placeholder="送信するメッセージを入力してください"></textarea>' +
'<div class="d-flex align-items-center gap-2">' +
'<button class="btn btn-primary" onclick="execMemberBroadcast()">📢 送信する</button>' +
'<span id="mResult" class="text-muted small"></span>' +
'</div></div>' +
'<div class="table-responsive">' +
'<table class="table table-sm table-hover bg-white">' +
'<thead class="table-light"><tr><th>名前</th><th>フリガナ</th><th>年齢</th><th>性別</th><th>テニスレベル</th><th>登録日</th></tr></thead>' +
'<tbody id="membersBody"></tbody>' +
'</table></div></div></div></div>' +

'</div>' +

'<script>' +
'var eventsData=[];' +
'var currentEvent=null;' +
'var bcastUserIds=[];' +
'var membersData=[];' +
'var mTargetIds=[];' +
'var membersLoaded=false;' +

'window.onload=function(){loadEvents();};' +

'function showTab(t){' +
'document.getElementById("tab-events").style.display=t==="events"?"":"none";' +
'document.getElementById("tab-broadcast").style.display=t==="broadcast"?"":"none";' +
'document.getElementById("tab-members").style.display=t==="members"?"":"none";' +
'document.getElementById("tab-btn-events").classList.toggle("active",t==="events");' +
'document.getElementById("tab-btn-broadcast").classList.toggle("active",t==="broadcast");' +
'document.getElementById("tab-btn-members").classList.toggle("active",t==="members");' +
'if(t==="members"&&!membersLoaded){membersLoaded=true;loadMembers();}' +
'}' +

'function spin(on){document.getElementById("spinner").style.display=on?"":"none";}' +

'function loadEvents(){' +
'spin(true);' +
'google.script.run.withSuccessHandler(function(ev){spin(false);renderEvents(ev);}).withFailureHandler(function(e){spin(false);alert("エラー: "+e.message);}).getEventsData();' +
'}' +

'function renderEvents(events){' +
'eventsData=events;' +
'var el=document.getElementById("eventList");' +
'el.innerHTML="";' +
'var sel=document.getElementById("bcastEvent");' +
'sel.innerHTML="<option value=\'\'>（選択してください）</option>";' +
'if(!events||events.length===0){el.innerHTML="<div class=\'col\'><p class=\'text-muted\'>設定シートにイベントがありません。</p></div>";return;}' +
'events.forEach(function(ev,idx){' +
'var badge=ev.pendingCount>0?"<span class=\'badge badge-pending ms-1\'>"+ev.pendingCount+"件未送信</span>":"";' +
'var div=document.createElement("div");' +
'div.className="col-md-4 col-lg-3";' +
'div.innerHTML="<div class=\'card event-card h-100 border\' onclick=\'selectEvent("+idx+")\'>"+' +
'"<div class=\'card-body py-2\'>"+' +
'"<div class=\'fw-bold mb-1\'>"+ev.name+badge+"</div>"+' +
'"<div class=\'text-muted small\'>開催: "+ev.eventDate+" / 締切: "+ev.closingDate+"</div>"+' +
'"<div class=\'small mt-1\'>応募: "+ev.appCount+"名 ／ 当選: "+ev.winCount+"名 ／ 落選: "+ev.loseCount+"名</div>"+' +
'"</div></div>";' +
'el.appendChild(div);' +
'var opt=document.createElement("option");' +
'opt.value=idx;opt.textContent=ev.name;sel.appendChild(opt);' +
'});' +
'}' +

'function selectEvent(idx){' +
'currentEvent=eventsData[idx];' +
'document.getElementById("applicantSection").style.display="";' +
'document.getElementById("applicantTitle").textContent=currentEvent.name+" — 応募者一覧";' +
'loadApplicants(currentEvent.appSheetName,currentEvent.resultSheetName);' +
'}' +

'function closeApplicants(){' +
'document.getElementById("applicantSection").style.display="none";' +
'currentEvent=null;' +
'}' +

'function loadApplicants(appSheetName,resultSheetName){' +
'spin(true);' +
'google.script.run.withSuccessHandler(function(ap){spin(false);renderApplicants(ap);}).withFailureHandler(function(e){spin(false);alert("エラー: "+e.message);}).getApplicants(appSheetName,resultSheetName);' +
'}' +

'function renderApplicants(applicants){' +
'var tbody=document.getElementById("applicantBody");' +
'tbody.innerHTML="";' +
'if(!applicants||applicants.length===0){' +
'tbody.innerHTML="<tr><td colspan=\'5\' class=\'text-center text-muted\'>応募者がいません。</td></tr>";return;' +
'}' +
'applicants.forEach(function(ap){' +
'var cls=ap.result?"status-"+ap.result:"status-未処理";' +
'var sentBadge=ap.sent==="済"?"<span class=\'badge bg-success\'>送信済</span>":"<span class=\'badge bg-secondary\'>未送信</span>";' +
'var tr=document.createElement("tr");' +
'tr.innerHTML="<td>"+ap.name+"</td>"+' +
'"<td class=\'text-muted small\'>"+ap.appliedAt+"</td>"+' +
'"<td class=\'"+cls+"\'>"+( ap.result||"未処理")+"</td>"+' +
'"<td>"+sentBadge+"</td>"+' +
'"<td>"+' +
'"<button class=\'btn btn-outline-success btn-sm py-0 me-1\' onclick=\'setResult(\\\""+ap.userId+"\\\",\\\"当選\\\",this)\'>当選</button>"+' +
'"<button class=\'btn btn-outline-danger btn-sm py-0\' onclick=\'setResult(\\\""+ap.userId+"\\\",\\\"落選\\\",this)\'>落選</button>"+' +
'"</td>";' +
'tbody.appendChild(tr);' +
'});' +
'}' +

'function setResult(userId,result,btn){' +
'if(!currentEvent)return;' +
'btn.disabled=true;' +
'google.script.run' +
'.withSuccessHandler(function(res){btn.disabled=false;if(res.success){loadApplicants(currentEvent.appSheetName,currentEvent.resultSheetName);}else{alert("エラー: "+res.error);}})' +
'.withFailureHandler(function(e){btn.disabled=false;alert("エラー: "+e.message);})' +
'.setResult(currentEvent.resultSheetName,userId,result);' +
'}' +

'function sendNotifications(){' +
'if(!currentEvent)return;' +
'if(!confirm("未送信の当落通知を一括送信します。よろしいですか？"))return;' +
'spin(true);' +
'google.script.run' +
'.withSuccessHandler(function(res){spin(false);if(res.success){alert("送信完了\\n当選: "+res.winCount+"名 / 落選: "+res.loseCount+"名");loadApplicants(currentEvent.appSheetName,currentEvent.resultSheetName);loadEvents();}else{alert("エラー: "+res.error);}})' +
'.withFailureHandler(function(e){spin(false);alert("エラー: "+e.message);})' +
'.sendResultsFromDashboard(currentEvent.resultSheetName);' +
'}' +

'function loadBcastUsers(){' +
'var idxVal=document.getElementById("bcastEvent").value;' +
'var status=document.getElementById("bcastStatus").value;' +
'if(!idxVal){alert("イベントを選択してください。");return;}' +
'var ev=eventsData[parseInt(idxVal)];' +
'spin(true);' +
'google.script.run' +
'.withSuccessHandler(function(users){' +
'spin(false);bcastUserIds=users.map(function(u){return u.userId;});' +
'var listEl=document.getElementById("bcastUserList");' +
'if(!users||users.length===0){listEl.textContent="対象者がいません。";}' +
'else{listEl.innerHTML="<div class=\'fw-bold mb-1\'>"+users.length+"名</div>"+users.map(function(u){return "<div>"+u.name+"</div>";}).join("");}' +
'})' +
'.withFailureHandler(function(e){spin(false);alert("エラー: "+e.message);})' +
'.getFilteredUsers(ev.appSheetName,ev.resultSheetName,status);' +
'}' +

'function execBroadcast(){' +
'var message=document.getElementById("bcastMessage").value.trim();' +
'if(!message){alert("メッセージを入力してください。");return;}' +
'if(bcastUserIds.length===0){alert("先に「対象者を確認」ボタンを押してください。");return;}' +
'if(!confirm(bcastUserIds.length+"名にメッセージを送信します。よろしいですか？"))return;' +
'spin(true);' +
'var resultEl=document.getElementById("bcastResult");resultEl.textContent="";' +
'google.script.run' +
'.withSuccessHandler(function(res){spin(false);if(res.success){resultEl.textContent="✅ "+res.count+"名に送信しました";document.getElementById("bcastMessage").value="";bcastUserIds=[];document.getElementById("bcastUserList").innerHTML="";}else{alert("エラー: "+res.error);}})' +
'.withFailureHandler(function(e){spin(false);alert("エラー: "+e.message);})' +
'.sendBroadcast(bcastUserIds,message);' +
'}' +

'function loadMembers(){' +
'spin(true);' +
'google.script.run' +
'.withSuccessHandler(function(data){spin(false);initMembersTab(data);})' +
'.withFailureHandler(function(e){spin(false);alert("エラー: "+e.message);})' +
'.getMembersData();' +
'}' +

'function initMembersTab(data){' +
'membersData=data;' +
'var levels=[...new Set(data.map(function(m){return m.tennisLevel;}).filter(function(v){return v;}))].sort();' +
'var sel=document.getElementById("mFilterLevel");' +
'sel.innerHTML="<option value=\'\'>全員</option>"+levels.map(function(l){return"<option value=\'"+l+"\'>"+l+"</option>";}).join("");' +
'renderMembersTable(data);' +
'}' +

'function renderMembersTable(members){' +
'var tbody=document.getElementById("membersBody");' +
'if(!members||members.length===0){tbody.innerHTML="<tr><td colspan=\'5\' class=\'text-center text-muted\'>会員データがありません。</td></tr>";return;}' +
'tbody.innerHTML=members.map(function(m){return"<tr><td>"+m.name+"</td><td class=\'text-muted\'>"+m.furigana+"</td><td>"+m.age+"</td><td>"+m.gender+"</td><td>"+m.tennisLevel+"</td><td class=\'text-muted small\'>"+m.registeredAt+"</td></tr>";}).join("");' +
'}' +

'function filterMembers(){' +
'var gender=document.getElementById("mFilterGender").value;' +
'var ageMin=parseInt(document.getElementById("mFilterAgeMin").value)||0;' +
'var ageMax=parseInt(document.getElementById("mFilterAgeMax").value)||999;' +
'var level=document.getElementById("mFilterLevel").value;' +
'var filtered=membersData.filter(function(m){' +
'if(gender&&m.gender!==gender)return false;' +
'if(m.age){var a=parseInt(m.age);if(!isNaN(a)&&(a<ageMin||a>ageMax))return false;}' +
'if(level&&m.tennisLevel!==level)return false;' +
'return true;' +
'});' +
'mTargetIds=filtered.map(function(m){return m.userId;});' +
'var listEl=document.getElementById("mTargetList");' +
'if(filtered.length===0){listEl.textContent="対象者がいません。";}' +
'else{listEl.innerHTML="<div class=\'fw-bold mb-1\'>"+filtered.length+"名</div>"+filtered.map(function(m){return"<div>"+m.name+"</div>";}).join("");}' +
'renderMembersTable(filtered);' +
'}' +

'function execMemberBroadcast(){' +
'var message=document.getElementById("mMessage").value.trim();' +
'if(!message){alert("メッセージを入力してください。");return;}' +
'if(mTargetIds.length===0){alert("先に「対象者を確認」ボタンを押してください。");return;}' +
'if(!confirm(mTargetIds.length+"名にメッセージを送信します。よろしいですか？"))return;' +
'spin(true);' +
'var resultEl=document.getElementById("mResult");resultEl.textContent="";' +
'google.script.run' +
'.withSuccessHandler(function(res){spin(false);if(res.success){resultEl.textContent="✅ "+res.count+"名に送信しました";document.getElementById("mMessage").value="";mTargetIds=[];document.getElementById("mTargetList").innerHTML="";}else{alert("エラー: "+res.error);}})' +
'.withFailureHandler(function(e){spin(false);alert("エラー: "+e.message);})' +
'.sendBroadcast(mTargetIds,message);' +
'}' +
'</script>' +
'</body></html>';
}
