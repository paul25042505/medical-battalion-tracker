/* =========================================================
   MEDTRACK 推播通知後端（Cloud Functions）

   四個 Firestore onCreate 觸發點（不監聽 update，「時間地點更新」實際上
   是指每一筆任務進度回報，本身就是新增一筆 events 文件，不是修改 tasks
   文件本身；公告編輯也一樣不重新推播，只有新增才推），外加兩個排程：
   1) tasks 新增 → 通知「新增勤務」（涵蓋一般勤務／待命車／洽公，待命車
      續約時 renewStandbyTask() 也會建立新的 tasks 文件，一樣會觸發）
   2) events 新增 → 通知任務進度回報（出勤/抵達現場/離開現場/返營/抵達
      營區，或洽公對應的出發/抵達/離開/返營）
   3) vitals 新增 → 若生命徵象任一項落在「danger」等級，通知生命徵象異常
   4) notifications 新增 → 訊息管理發布的公告，推播給所有在職帳號
   5) 排程（每天一次）→ 公告／推播個人紀錄效期一到就自動刪除
      （cleanupExpiredNotifications）
   6) 排程（每天一次，08:10）→ 待命車超過每日 08:00 換班還沒續約提醒
      （checkStaleErStandby）
   7) 排程（每天一次，07:00）→ 每日天氣摘要，依各單位所在縣市附上當天
      天氣與生效中的強風/大雨等特報、颱風警報（sendDailyWeatherReport）

   收件人規則：前三個觸發＋待命車換班提醒依單位隔離，跟前端 RBAC 一致——
   高勤官／admin 收全單位的通知，主官管／一般成員只收自己單位的；公告是
   全體公告，沒有單位隔離，不分單位推給所有在職帳號（見 resolveAllTokens）；
   每日天氣摘要依「單位對應縣市」分組（見 UNIT_WEATHER_LOCATION），同縣市
   的單位收到同一份內容，不分角色，在職帳號都收得到。

   個人通知中心（鈴鐺）紀錄：除了公告本身（notifications 集合，全體共用）
   之外，上面每一次「實際推播給誰」都會額外在 pushLog 集合幫每個收件人
   各寫一筆個人化紀錄（見 writePushLog／notifyRecipients），讓使用者事後
   能在自己的通知中心回頭查看系統實際推播過的內容，效期 30 天，跟公告
   共用同一支 cleanupExpiredNotifications 排程清除。
   ========================================================= */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const { getAuth } = require("firebase-admin/auth");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

initializeApp();
const db = getFirestore();

// 跟 Firestore Hosting/Rules 同一個地區設定即可，Cloud Functions 預設
// us-central1，這裡沒有特別理由要換区域，維持預設降低設定複雜度。
setGlobalOptions({ maxInstances: 10 });

// 舊資料可能還留著角色模型改版前的 "company_commander"，前端一律用
// normalizeRole() 轉成 "commander" 再判斷，這裡要跟著做，不然舊帳號
// 會漏掉收不到通知。
function normalizeRole(role) { return role === "company_commander" ? "commander" : role; }

/* =========================================================
   共用：依角色/單位規則找出這個單位的任務該通知誰。回傳完整的收件人
   清單 {uid, tokens}——tokens 可能是空陣列（代表這個人還沒設定推播裝置），
   刻意不在這裡就篩掉沒有 token 的人：實際送推播（sendPush）只會用到有
   token 的那些，但個人通知中心的紀錄（pushLog）要涵蓋「應該收到這則通知
   的所有人」，不管他當下有沒有裝置能收到即時推播，之後開啟本系統還是
   看得到這則通知，不會因為推播沒送達就永遠看不到內容。
   ========================================================= */
async function resolveRecipients(taskUnit) {
  const snap = await db.collection("users").get();
  const recipients = [];
  snap.forEach((doc) => {
    const u = doc.data();
    const role = normalizeRole(u.role);
    const isBroad = role === "admin" || role === "duty_officer";
    const isUnitScoped = (role === "commander" || role === "member") && u.unit === taskUnit;
    if (!isBroad && !isUnitScoped) return;
    recipients.push({ uid: doc.id, tokens: Array.isArray(u.fcmTokens) ? u.fcmTokens : [] });
  });
  return recipients;
}
// 公告沒有單位隔離，是全體公告，找所有在職帳號（admin/高勤官/主官管/
// 一般成員）的 fcmTokens，不分單位；pending/disabled/unclaimed 這幾種
// 非在職狀態不算，跟 resolveRecipients 的隱含排除邏輯一致。
async function resolveAllTokens() {
  const snap = await db.collection("users").get();
  const tokens = new Set();
  const activeRoles = ["admin", "duty_officer", "commander", "member"];
  snap.forEach((doc) => {
    const u = doc.data();
    if (!Array.isArray(u.fcmTokens) || !u.fcmTokens.length) return;
    if (!activeRoles.includes(normalizeRole(u.role))) return;
    u.fcmTokens.forEach((t) => tokens.add(t));
  });
  return [...tokens];
}

/* =========================================================
   管理員測試模式：管理員在測試某項功能（會觸發推播的操作，例如建立
   勤務、回報進度）時，可以暫時關閉「發給大家」的推播通知，不用真的
   打擾所有人才能測試。設定存在單一文件 settings/testMode（見
   index.html 的「系統設定」頁，__toggleTestMode 負責寫入），開啟時
   固定 1 小時後自動失效（比對 expiresAt，不需要另外排程清除，過期
   後這裡直接判定為未開啟）。

   影響範圍：新增勤務／進度回報／生命徵象異常／公告／待命車換班提醒／
   緊急動員廣播／每日天氣摘要——這些「發給大家」的推播（含個人通知中心
   紀錄 pushLog）都會略過。「推播控制台」的單人測試推播（sendTestPush）
   刻意不受影響：那是管理員自己選定單一對象、確認裝置設定是否正常的
   診斷工具，不是「打擾大家」的通知，測試模式開著時如果連這個都失效，
   反而讓管理員搞不清楚裝置設定本身到底有沒有問題。
   ========================================================= */
async function isTestModeActive() {
  try {
    const doc = await db.doc("settings/testMode").get();
    if (!doc.exists) return false;
    const d = doc.data();
    if (!d.enabled) return false;
    const expiresAtMs = d.expiresAt && d.expiresAt.toMillis ? d.expiresAt.toMillis() : new Date(d.expiresAt || 0).getTime();
    return Date.now() < expiresAtMs;
  } catch (e) {
    logger.error("讀取測試模式設定失敗，視為未開啟（維持正常發送推播，不因為讀取失敗誤把通知擋下來）", e);
    return false;
  }
}

/* =========================================================
   共用：實際送出推播＋清掉失效的 token（使用者解除安裝、清除瀏覽器
   資料、手動關閉通知權限等情況都會讓 token 失效，不清掉的話下次還是
   會白工嘗試送到同一個死掉的 token）
   ========================================================= */
async function sendPush(tokens, title, body) {
  // 之前這裡完全沒有 info 等級的紀錄，「找不到收件人」「送出成功」「送出
  // 但每個 token 都失敗」在 Cloud Functions 的 Logs 裡看起來一模一樣（都是
  // 執行成功、沒有任何 log），沒辦法排查「訂閱了但收不到」是卡在哪一步。
  // 這裡補上：沒收件人時明確記一筆、送出後記成功/失敗筆數、每個失敗的
  // token 記下實際的錯誤代碼。
  if (!tokens.length) { logger.info(`推播「${title}」沒有符合資格的收件人（找不到 fcmTokens），略過`); return; }
  const messaging = getMessaging();
  let resp;
  try {
    // 故意用 data（純資料）而不是 notification 欄位：背景/鎖屏收到帶
    // notification 欄位的訊息時，瀏覽器本身會自動跳出一則通知，我們的
    // service worker 的 onBackgroundMessage 又會自己再呼叫一次
    // showNotification()，兩邊各顯示一次，同一則推播會變成兩則通知。
    // 全部改成純 data，交給 service worker 自己顯示，只會顯示一次。
    resp = await messaging.sendEachForMulticast({ tokens, data: { title, body } });
  } catch (e) {
    logger.error("推播傳送失敗", e);
    return;
  }
  logger.info(`推播「${title}」送出 ${tokens.length} 筆 token，成功 ${resp.successCount}，失敗 ${resp.failureCount}`);
  const invalidTokens = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      logger.warn(`推播失敗（token 結尾 …${tokens[i].slice(-8)}）：${code || (r.error && r.error.message) || r.error}`);
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        invalidTokens.push(tokens[i]);
      }
    }
  });
  if (invalidTokens.length) await removeInvalidTokens(invalidTokens);
}
async function removeInvalidTokens(invalidTokens) {
  // array-contains-any 一次最多比對 10 個值，保守起見分批查詢。
  for (let i = 0; i < invalidTokens.length; i += 10) {
    const chunk = invalidTokens.slice(i, i + 10);
    try {
      const snap = await db.collection("users").where("fcmTokens", "array-contains-any", chunk).get();
      const batch = db.batch();
      snap.forEach((doc) => {
        const u = doc.data();
        const updated = (u.fcmTokens || []).filter((t) => !invalidTokens.includes(t));
        batch.update(doc.ref, { fcmTokens: updated });
      });
      await batch.commit();
    } catch (e) {
      logger.error("清除失效 token 失敗", e);
    }
  }
}

/* =========================================================
   系統實際推播過的內容，每個收件人都能在自己的「通知中心」（鈴鐺）回頭
   查看，效期 30 天（跟公告的 NOTIFICATION_TTL_DAYS 用同一個天數，一起由
   cleanupExpiredNotifications 排程清除）。獨立存在 pushLog 集合（不是
   寫進公告用的 notifications 集合）：公告是全體共用、不分帳號的公告板，
   pushLog 是「這則訊息實際上是推播給我的」個人化紀錄，firestore.rules
   只允許 uid 等於自己的人讀到，兩者資料語意不同，不能混在一起。
   ========================================================= */
const PUSHLOG_TTL_DAYS = 30;
async function writePushLog(uids, title, body) {
  if (!uids.length) return;
  const expiresAt = new Date(Date.now() + PUSHLOG_TTL_DAYS * 24 * 60 * 60 * 1000);
  const timestamp = new Date();
  const batch = db.batch();
  uids.forEach((uid) => {
    batch.set(db.collection("pushLog").doc(), { uid, title, body, isRead: false, timestamp, expiresAt });
  });
  await batch.commit();
}
// 送推播＋順便幫每個收件人在自己的通知中心留一筆紀錄，兩件事綁在一起做，
// 避免每個觸發點都要各自記得呼叫兩次。
async function notifyRecipients(recipients, title, body) {
  if (await isTestModeActive()) {
    logger.info(`測試模式開啟中，略過推播「${title}」（不送推播、不寫入通知中心）`);
    return;
  }
  const tokens = recipients.flatMap((r) => r.tokens);
  await sendPush(tokens, title, body);
  await writePushLog(recipients.map((r) => r.uid), title, body);
}

/* =========================================================
   Eventarc/Pub-Sub 底層是「至少送達一次」，同一個事件在函式冷啟動、處理
   稍微慢一點等情況下可能被重複投遞，導致同一次新增/回報被推播兩三次。
   用 event.id（同一個底層事件重複投遞時這個 id 是同一組）搭配 Firestore
   .create() 的原子性「搶佔」語意做冪等防護：第二次進來時 .create() 一定
   會因為文件已存在而丟出 ALREADY_EXISTS，直接跳過即可。
   ========================================================= */
async function claimEventOnce(eventId) {
  try {
    await db.collection("_pushEventDedup").doc(eventId).create({ processedAt: new Date() });
    return true;
  } catch (e) {
    if (e.code === 6) return false; // ALREADY_EXISTS
    throw e;
  }
}

/* =========================================================
   1) 任務新增
   ========================================================= */
exports.onTaskCreated = onDocumentCreated("tasks/{taskId}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const t = snap.data();
  if (!t || !t.unit) return;
  const recipients = await resolveRecipients(t.unit);
  const typeLabel = t.type === "liaison" ? "洽公" : (t.erStandbyKey ? "待命車" : "勤務");
  const title = `新增${typeLabel}`;
  const body = [t.title, t.location].filter(Boolean).join("：") || `已建立新的${typeLabel}`;
  await notifyRecipients(recipients, title, body);
});

/* =========================================================
   2) 任務進度回報（events 新增）
   ========================================================= */
const EVENT_LABELS = {
  DISPATCH: "出勤",
  ARRIVED_SCENE: "抵達現場",
  DEPART_SCENE: "離開現場",
  RETURNING: "返營",
  COMPLETED: "抵達營區",
};
exports.onEventCreated = onDocumentCreated("events/{eventId}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const e = snap.data();
  if (!e || !e.taskId) return;
  const taskSnap = await db.doc(`tasks/${e.taskId}`).get();
  if (!taskSnap.exists) return;
  const t = taskSnap.data();
  const recipients = await resolveRecipients(t.unit);
  const label = EVENT_LABELS[e.type] || e.type;
  const title = `${t.title || "勤務"} - ${label}`;
  const body = [t.vehicle, e.location || e.hospital].filter(Boolean).join(" @ ") || t.location || "";
  await notifyRecipients(recipients, title, body);
});

/* =========================================================
   3) 患者生命徵象危急異常（vitals 新增）
   門檻值照抄前端 index.html 的 hrSeverity/rrSeverity/spo2Severity/
   bpSeverity/tempSeverity/gcsSeverity/consciousnessSeverity，兩邊
   如果以後要調整危急門檻，記得兩邊要一起改。
   ========================================================= */
function hrDanger(n) { return !isNaN(n) && !(n >= 50 && n <= 120); }
function rrDanger(n) { return !isNaN(n) && !(n >= 8 && n <= 24); }
function spo2Danger(n) { return !isNaN(n) && n < 90; }
function tempDanger(n) { return !isNaN(n) && !(n >= 35 && n <= 38.5); }
function bpDanger(bpStr) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec((bpStr || "").trim());
  if (!m) return false;
  const sys = Number(m[1]), dia = Number(m[2]);
  return !(sys >= 80 && sys < 160) || !(dia >= 50 && dia < 100);
}
function gcsTotalFromString(gcsStr) {
  const s = gcsStr || "";
  const totalMatch = /(\d+)\s*分/.exec(s);
  if (totalMatch) return Number(totalMatch[1]);
  const evm = /E(\d).*V(\d).*M(\d)/.exec(s);
  if (evm) return Number(evm[1]) + Number(evm[2]) + Number(evm[3]);
  if (/^\d+$/.test(s.trim())) return Number(s.trim());
  return NaN;
}
function gcsDanger(gcsStr) {
  const total = gcsTotalFromString(gcsStr);
  return !isNaN(total) && total < 9;
}
function consciousnessDanger(c) { return c === "否"; }
function isVitalsDanger(v) {
  return (
    consciousnessDanger(v.consciousness) ||
    bpDanger(v.bp) ||
    hrDanger(Number(v.hr)) ||
    spo2Danger(Number(v.spo2)) ||
    rrDanger(Number(v.rr)) ||
    tempDanger(Number(v.temp)) ||
    gcsDanger(v.gcs)
  );
}
exports.onVitalsCreated = onDocumentCreated("vitals/{vitalsId}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const v = snap.data();
  if (!v || !v.taskId || !isVitalsDanger(v)) return;
  const taskSnap = await db.doc(`tasks/${v.taskId}`).get();
  if (!taskSnap.exists) return;
  const t = taskSnap.data();
  const recipients = await resolveRecipients(t.unit);
  await notifyRecipients(recipients, "患者生命徵象異常", `${t.title || "勤務"}：患者生命徵象出現危急異常，請留意`);
});

/* =========================================================
   4) 公告新增（訊息管理 → 新增公告，或主官管「發送單位訊息」）：只有
   新增才推播，編輯/刪除不重推，避免同一則公告被改個字就再打擾大家一次。
   isRead 標記已讀是前端另外直接寫 Firestore 的動作，不會新增文件，不會
   誤觸這個 trigger。
   帶 unit 欄位的是主官管發的單位訊息（見 firestore.rules 的 notifications
   create 規則、index.html 的 window.__sendCommanderBroadcast），只推播
   給那個單位（沿用 resolveRecipients，跟任務通知同一套「admin/高勤官
   收全部，該單位主官管/一般成員才收得到」規則）；沒有 unit 欄位的維持
   原本全體公告行為，推播給所有在職帳號。
   ========================================================= */
exports.onNotificationCreated = onDocumentCreated("notifications/{id}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const n = snap.data();
  if (!n || !n.title) return;
  if (await isTestModeActive()) {
    logger.info(`測試模式開啟中，略過公告推播「${n.title}」`);
    return;
  }
  if (n.unit) {
    const recipients = await resolveRecipients(n.unit);
    const tokens = recipients.flatMap((r) => r.tokens);
    await sendPush(tokens, n.title, n.body || "");
    return;
  }
  const tokens = await resolveAllTokens();
  await sendPush(tokens, `公告：${n.title}`, n.body || "");
});

/* =========================================================
   5) 效期到期自動刪除：公告（index.html 新增公告時帶一個 expiresAt，
   建立當下起算一個月，見 NOTIFICATION_TTL_DAYS）跟系統推播個人紀錄
   （pushLog，見 writePushLog，效期 30 天）都用同一支排程每天清一次，
   不是前端隱藏而已。舊資料（合併/上線前建立、沒有 expiresAt 欄位的
   公告）不會被這個查詢篩到，不會被誤刪，會一直留著；之後要清也可以
   手動在 Firestore 主控台刪除。
   ========================================================= */
exports.cleanupExpiredNotifications = onSchedule("every 24 hours", async () => {
  for (const collectionId of ["notifications", "pushLog"]) {
    const snap = await db.collection(collectionId).where("expiresAt", "<=", new Date()).get();
    if (snap.empty) continue;
    const batch = db.batch();
    snap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    logger.info(`清除 ${snap.size} 筆過期的 ${collectionId}`);
  }
});

/* =========================================================
   6) 預先建立人員帳號：管理員可以先幫還沒登入過的成員預建一筆資料
   （role:"unclaimed"，含 email），對方第一次用該 email 登入時，前端會在
   users/{uid} 建立一筆 role:"pending" 的新帳號（見 index.html 的
   onAuthStateChanged）。這裡監聽 users 新增，只處理「使用者自己登入建立
   的 pending 帳號」這種情況（role:"unclaimed" 的預建文件本身被建立時
   也會觸發這個 trigger，用 role !== "pending" 直接跳過，避免處理到自己）：
   比對 email 找有沒有相符的 role:"unclaimed" 預建資料，有的話直接把
   單位/階級/電話/EMT證照寫回這個新帳號、角色設成一般成員，不用等管理員
   手動審核；同時刪掉那筆預建文件（人員名冊與帳號已經合併成同一份
   users 集合，不用再另外維護一份 mirror）。

   一定要用 client 端無法做到的方式（Cloud Function 的後台權限）才能查
   其他 unclaimed 文件：一個全新、還沒被指派單位的帳號，依 firestore.rules
   （sameUnit() 需要先有單位才能讀取其他人的 users 文件），沒有權限自己
   查有沒有預建資料，只能靠後端用 Admin SDK（不受安全規則限制）代為比對。

   信箱比對前先轉小寫、去頭尾空白，避免大小寫或多打空格造成配對不到；
   有重複信箱的預建資料只會取第一筆，不特別擋（表單目前也沒做唯一性
   檢查）。沒有 unit 的預建資料理論上不會發生（新增人員的表單一定要選
   單位），這裡不另外防呆。 ========================================= */
exports.onUserCreated = onDocumentCreated("users/{uid}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const uid = event.params.uid;
  const u = snap.data();
  if (!u || u.role !== "pending") return;
  const email = u.email ? String(u.email).trim().toLowerCase() : "";
  if (!email) return;
  const match = await db.collection("users").where("role", "==", "unclaimed").where("email", "==", email).limit(1).get();
  if (match.empty) return;
  const doc = match.docs[0];
  const person = doc.data();
  const batch = db.batch();
  batch.set(db.collection("users").doc(uid), {
    role: "member",
    unit: person.unit || "",
    rank: person.rank || "",
    phone: person.phone || "",
    emtLevel: person.emtLevel || "",
    displayName: u.displayName || person.displayName || "",
  }, { merge: true });
  batch.delete(doc.ref);
  await batch.commit();
  logger.info(`帳號 ${uid}（${email}）比對到預建人員資料，已自動指派單位 ${person.unit}`);
});

/* =========================================================
   7)【一次性遷移，跑完後要整支移除】把合併前的 personnel 集合資料轉進
   users 集合。只能由 admin 呼叫：帶 Authorization: Bearer <Firebase ID
   token>（登入後在瀏覽器 devtools 執行
   `await firebase.auth().currentUser.getIdToken()` 取得），函式會驗證
   token 並確認呼叫者在 users 集合裡的 role 是 "admin" 才會執行——不需要
   額外另外設定密鑰，直接沿用既有的帳號權限模型。

   對每一筆 personnel 文件：
   - 文件 id 已經有對應的 users/{uid} 帳號（早期 syncPersonnelFromUsers
     產生、id 就是真實 uid）→ 把名冊欄位併回那筆帳號文件，不動 role/email。
   - 沒有對應帳號（純花名冊資料）→ 用同一個文件 id 在 users 建一筆
     role:"unclaimed" 的新文件，等本人之後登入被上面的 onUserCreated 認領。
   處理完就把原本的 personnel 文件刪掉。
   ========================================================= */
exports.migratePersonnelToUsers = onRequest(async (req, res) => {
  try {
    const authHeader = req.get("Authorization") || "";
    const m = /^Bearer (.+)$/.exec(authHeader);
    if (!m) { res.status(401).send("missing bearer token"); return; }
    const decoded = await getAuth().verifyIdToken(m[1]);
    const callerDoc = await db.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== "admin") {
      res.status(403).send("admin only");
      return;
    }
    const personnelSnap = await db.collection("personnel").get();
    let merged = 0, createdUnclaimed = 0;
    for (const doc of personnelSnap.docs) {
      const p = doc.data();
      const existing = await db.collection("users").doc(doc.id).get();
      if (existing.exists) {
        await db.collection("users").doc(doc.id).set({
          displayName: p.name || existing.data().displayName || "",
          rank: p.title || "",
          phone: p.phone || "",
          emtLevel: p.emtLevel || "",
        }, { merge: true });
        merged++;
      } else {
        await db.collection("users").doc(doc.id).set({
          displayName: p.name || "",
          rank: p.title || "",
          phone: p.phone || "",
          emtLevel: p.emtLevel || "",
          unit: p.unit || "",
          email: p.email ? String(p.email).trim().toLowerCase() : "",
          role: "unclaimed",
          fcmTokens: [],
          createdAt: new Date(),
        });
        createdUnclaimed++;
      }
      await doc.ref.delete();
    }
    res.status(200).json({ ok: true, merged, createdUnclaimed, total: personnelSnap.size });
  } catch (e) {
    logger.error("人員資料遷移失敗", e);
    res.status(500).send(String(e && e.message || e));
  }
});

/* =========================================================
   8) 健保署急診即時資訊同步（每 15 分鐘）
   來源：衛福部中央健康保險署「重度級急救責任醫院急診即時訊息」，只涵蓋
   重度級急救責任醫院（醫院資訊頁的「醫院層級」是我們自己的分類，跟這裡
   無關），不是每一間醫院都查得到資料。前端用「基礎資料管理→醫院」裡
   admin 手動填的「健保特約代號」（hospitals/{id}.nhiCode）比對是哪一間。

   改用後端排程呼叫（而不是前端每個使用者的手機各自直接打這支公開
   API）有兩個理由：一是這個政府端點是否允許瀏覽器端跨網域（CORS）直接
   呼叫並不確定，用後端呼叫完全不受這個限制；二是不用讓全營每支手機都
   各自打一次這支公開 API，一次排程呼叫、全部使用者共用同一份快取結果
   即可。整包存成單一文件（不是一間醫院一個文件），前端一次讀取後自己
   在記憶體裡比對，不用另外查詢。

   欄位解讀依需求文件給的欄位名稱，但無法在部署前實際打這支 API 驗證
   真正的欄位名稱大小寫是否完全一致，所以下面把回傳的第一筆資料完整
   記錄到 log，部署後如果前端比對不到資料，先看這筆 log 裡實際的欄位
   名稱，再調整前端的 ER_*_KEYS 對照表即可，不需要重新部署這支函式本身。
   ========================================================= */
exports.syncErRealtime = onSchedule("every 15 minutes", async () => {
  try {
    const res = await fetch("https://info.nhi.gov.tw/api/inae4000/inae4001s01/SQL0002", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ AREA_NO: "", CONT_TYPE: "" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const records = Array.isArray(data) ? data
      : Array.isArray(data && data.data) ? data.data
      : Array.isArray(data && data.records) ? data.records
      : [];
    if (records.length) logger.info("健保署急診即時資訊範例（第一筆原始資料，供比對欄位名稱用）", records[0]);
    await db.doc("erRealtime/latest").set({ records, fetchedAt: new Date(), recordCount: records.length });
    logger.info(`健保署急診即時資訊同步完成，共 ${records.length} 筆`);
  } catch (e) {
    logger.error("健保署急診即時資訊同步失敗", e);
  }
});

/* =========================================================
   9) 待命車超過每日 08:00 換班還沒續約提醒（排程，每天一次）
   跟前端 isStandbyStale()/standbyShiftCutoff()（index.html）同一套邏輯：
   erStandby/{key} 只存一個 currentTaskId 指標，指向目前綁定的任務——不管
   是還沒出勤的「待命勤務」還是正在出勤中的任務，只要完成（COMPLETED）
   就會由 renewStandbyTask() 自動建立新任務並更新這個指標，createdAt 會
   變成當下時間。所以「createdAt 早於今天最近一次 08:00」就代表這個
   待命點從昨天（甚至更早）到現在都沒有經過 renewStandbyTask()，也就是
   車長/駕駛換班時沒有回報，需要提醒確認。

   ER_STANDBY_LOCATIONS 是前端 index.html 的常數，這裡沒有共用模組可以
   直接 import，手動維護一份對照——之後前端新增/調整待命地點時記得同步
   改這裡。
   ========================================================= */
const ER_STANDBY_LOCATIONS = [
  { key: "chenggongbei", label: "成功北醫務所" },
  { key: "jingbei", label: "精北醫務所" },
];
function standbyShiftCutoff(now) {
  const cutoff = new Date(now);
  cutoff.setHours(8, 0, 0, 0);
  if (now < cutoff) cutoff.setDate(cutoff.getDate() - 1);
  return cutoff;
}
exports.checkStaleErStandby = onSchedule({ schedule: "10 8 * * *", timeZone: "Asia/Taipei" }, async () => {
  const cutoffMs = standbyShiftCutoff(new Date()).getTime();
  const snap = await db.collection("erStandby").get();
  for (const doc of snap.docs) {
    const rec = doc.data();
    if (!rec || !rec.currentTaskId) continue;
    const taskSnap = await db.doc(`tasks/${rec.currentTaskId}`).get();
    if (!taskSnap.exists) continue;
    const t = taskSnap.data();
    const createdAtMs = t.createdAt && t.createdAt.toMillis ? t.createdAt.toMillis() : new Date(t.createdAt || 0).getTime();
    if (createdAtMs >= cutoffMs) continue;
    const locLabel = (ER_STANDBY_LOCATIONS.find((x) => x.key === doc.id) || {}).label || doc.id;
    const recipients = await resolveRecipients(t.unit);
    await notifyRecipients(recipients, "待命車尚未換班", `${locLabel}（${t.vehicle || "—"}）尚未於今日 08:00 後更新，請確認車長/駕駛是否需要換班`);
  }
});

/* =========================================================
   10) 每日天氣摘要（排程，每天 07:00 Asia/Taipei）
   跟前端 index.html 天氣頁「今日」卡片同一組資料集：F-C0032-001（今明
   36 小時預報，取第一個時段）＋W-C0033-001（天氣特報，強風/大雨等）；
   颱風警報 W-C0034-001 全國只有一份，不分縣市，只要生效中就一併附加。
   CWA_API_KEY／UNIT_WEATHER_LOCATION 跟前端是同一份設定值，這裡沒有共用
   模組可以 import，手動複製一份（本來就是內嵌在前端原始碼裡的公開金鑰，
   不是密鑰，重複並不會有安全疑慮，做法跟 ER_STANDBY_LOCATIONS 一致）；
   之後前端如果調整單位對應的縣市，記得同步改這裡。

   只對「有人在」的縣市各打一次天氣/特報 API（實務上目前只有臺中市／
   嘉義縣兩份），同縣市的所有在職帳號共用同一份查詢結果，不用每個人各自
   查一次；颱風警報全國共用同一份，也只查一次。
   ========================================================= */
const CWA_API_KEY = "CWA-C471B712-733E-4115-9AD2-0E1D96D3A10E";
const UNIT_WEATHER_LOCATION = { hq: "臺中市", co1: "臺中市", co2: "嘉義縣" };

async function fetchDailyWeather(county) {
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?Authorization=${CWA_API_KEY}&locationName=${encodeURIComponent(county)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const loc = json?.records?.location?.[0];
  if (!loc) throw new Error("查無天氣資料");
  const els = {};
  loc.weatherElement.forEach((e) => { els[e.elementName] = e.time; });
  return {
    wx: els.Wx?.[0]?.parameter?.parameterName || "—",
    pop: els.PoP?.[0]?.parameter?.parameterName ?? null,
    minT: els.MinT?.[0]?.parameter?.parameterName ?? null,
    maxT: els.MaxT?.[0]?.parameter?.parameterName ?? null,
  };
}
async function fetchDailyHazards(county) {
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0033-001?Authorization=${CWA_API_KEY}&locationName=${encodeURIComponent(county)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const locs = json?.records?.location || [];
  const loc = locs.find((l) => l.locationName === county) || locs[0];
  const hazards = loc?.hazardConditions?.hazards || [];
  return hazards.map((h) => `${h.info?.phenomena || "天氣特報"}${h.info?.significance || ""}`);
}
async function fetchActiveTyphoonHeadlines() {
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-001?Authorization=${CWA_API_KEY}&format=JSON`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const infos = json?.records?.info || [];
  // 氣象署解除警報時會先發一則「警報解除」公告，這則公告本身也會出現在
  // 「目前生效中」的清單裡一兩天，如果照樣當成警報顯示，解除後還是會
  // 每天提醒，所以標題含「解除」的直接濾掉，不算進生效中的警報。
  return infos.map((info) => info.headline || "颱風警報").filter((h) => !h.includes("解除"));
}
// 出車勤務提醒依實際天氣狀況擇一顯示（不是每天固定一句）：颱風警報 >
// 天氣特報 > 降雨機率高／預報描述有雨，同時符合多項時只顯示最嚴重的
// 那一種，避免同一天疊好幾句意思重複的提醒。降雨機率的門檻（50%）是
// 跟人一起討論後定案的，不要沒討論就調整。
const DAILY_WEATHER_RAIN_POP_THRESHOLD = 50;
function buildDailyWeatherReminder(weather, hazardTexts, typhoonTexts) {
  if (typhoonTexts.length) return `颱風警報生效中（${typhoonTexts[0]}），出車勤務請特別注意`;
  if (hazardTexts.length) return `目前有${hazardTexts.join("、")}，出車請提高警覺`;
  const highRainChance = weather.pop != null && weather.pop >= DAILY_WEATHER_RAIN_POP_THRESHOLD;
  const rainyForecast = weather.wx && weather.wx.includes("雨");
  if (highRainChance || rainyForecast) return "出車勤務請注意路滑，保持安全車距";
  return "";
}
function buildDailyWeatherBody(county, weather, hazardTexts, typhoonTexts) {
  const range = (weather.minT != null && weather.maxT != null) ? `${weather.minT}到${weather.maxT}度` : "";
  const pop = weather.pop != null ? `，降雨機率${weather.pop}%` : "";
  let body = `今天${county}${weather.wx}${range ? "，氣溫" + range : ""}${pop}`;
  const reminder = buildDailyWeatherReminder(weather, hazardTexts, typhoonTexts);
  if (reminder) body += `\n⚠️ ${reminder}`;
  return body;
}
// 核心邏輯獨立成一個函式，排程觸發跟下面的手動測試端點都呼叫同一份，
// 避免兩邊的查詢/組字/收件人邏輯各寫一套、之後改一邊忘了改另一邊。
async function runDailyWeatherReport() {
  if (await isTestModeActive()) {
    logger.info("測試模式開啟中，略過每日天氣摘要推播");
    return { skipped: true, testMode: true };
  }
  const counties = [...new Set(Object.values(UNIT_WEATHER_LOCATION))];
  const typhoonTexts = await fetchActiveTyphoonHeadlines().catch((e) => {
    logger.error("每日天氣摘要：颱風警報載入失敗", e);
    return [];
  });
  const dataByCounty = {};
  for (const county of counties) {
    try {
      const [weather, hazardTexts] = await Promise.all([
        fetchDailyWeather(county),
        fetchDailyHazards(county).catch((e) => {
          logger.error(`每日天氣摘要：${county} 特報載入失敗`, e);
          return [];
        }),
      ]);
      dataByCounty[county] = { weather, hazardTexts };
    } catch (e) {
      logger.error(`每日天氣摘要：${county} 天氣載入失敗，這個縣市今天不推播`, e);
    }
  }

  const snap = await db.collection("users").get();
  const activeRoles = ["admin", "duty_officer", "commander", "member"];
  const recipientsByCounty = {};
  snap.forEach((doc) => {
    const u = doc.data();
    if (!activeRoles.includes(normalizeRole(u.role))) return;
    const county = UNIT_WEATHER_LOCATION[u.unit] || UNIT_WEATHER_LOCATION.hq;
    if (!dataByCounty[county]) return;
    (recipientsByCounty[county] = recipientsByCounty[county] || []).push({
      uid: doc.id,
      tokens: Array.isArray(u.fcmTokens) ? u.fcmTokens : [],
    });
  });

  const sent = [];
  for (const [county, recipients] of Object.entries(recipientsByCounty)) {
    const { weather, hazardTexts } = dataByCounty[county];
    const title = `${county} 今日天氣`;
    const body = buildDailyWeatherBody(county, weather, hazardTexts, typhoonTexts);
    await notifyRecipients(recipients, title, body);
    // recipients 涵蓋「這個縣市所有在職帳號」，不管當下有沒有裝置 token
    // （這是 pushLog 個人通知中心紀錄要用到的完整名單，見 resolveRecipients
    // 的說明）；如果直接拿 recipients.length 當「已發送」人數回報，會出現
    // 「顯示成功、還附上人數」但這些人其實一個都沒有註冊裝置 token、
    // 實際上沒有任何一支手機收到推播的情況，看起來像成功了但其實沒送出
    // 真正的推播。這裡另外算出真正「有裝置可收」的人數，回報給管理員看
    // 才能判斷到底是「這個人沒開推播權限」還是「這支函式真的沒送到」。
    const pushableCount = recipients.filter((r) => r.tokens.length > 0).length;
    sent.push({ county, title, body, matchedCount: recipients.length, recipientCount: pushableCount });
  }
  return { skipped: false, sent };
}
exports.sendDailyWeatherReport = onSchedule({ schedule: "0 7 * * *", timeZone: "Asia/Taipei" }, async () => {
  await runDailyWeatherReport();
});

/* =========================================================
   10b) 每日天氣摘要：管理員手動立即觸發一次（測試用）
   跟排程呼叫同一份 runDailyWeatherReport()，方便部署後不用等到隔天
   07:00 才能確認訊息內容、單位對應的縣市是否正確；呼叫慣例跟其他手動
   測試端點（sendTestPush／migratePersonnelToUsers）一致。
   ========================================================= */
exports.sendDailyWeatherReportNow = onRequest({ cors: true }, async (req, res) => {
  try {
    const authHeader = req.get("Authorization") || "";
    const m = /^Bearer (.+)$/.exec(authHeader);
    if (!m) { res.status(401).json({ ok: false, reason: "missing bearer token" }); return; }
    const decoded = await getAuth().verifyIdToken(m[1]);
    const callerDoc = await db.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== "admin") {
      res.status(403).json({ ok: false, reason: "admin only" });
      return;
    }
    const result = await runDailyWeatherReport();
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    logger.error("手動觸發每日天氣摘要失敗", e);
    res.status(500).json({ ok: false, reason: String(e && e.message || e) });
  }
});

/* =========================================================
   11) 推播控制台：管理員手動測試推播
   前端「推播控制台」名冊每一列的「測試推播」按鈕呼叫這支函式，直接對
   指定的單一使用者送一則真的推播（跟 sendPush() 共用同一套發送/清除
   失效 token 邏輯），方便管理員現場確認某個人到底收不收得到通知，不用
   等真的有任務/生命徵象異常才能驗證。

   用 onRequest（HTTP function，cors:true 讓瀏覽器可以直接跨網域呼叫）而
   不是 onCall：這個專案其餘前端一律用 fetch 直接打 REST API（沒有引入
   Firebase JS SDK 的 Firestore/Functions 用戶端函式庫），跟既有的
   migratePersonnelToUsers 同一套「Bearer ID token + 後端驗證呼叫者
   role」的呼叫慣例一致，不用另外載入 Functions SDK。
   ========================================================= */
exports.sendTestPush = onRequest({ cors: true }, async (req, res) => {
  try {
    const authHeader = req.get("Authorization") || "";
    const m = /^Bearer (.+)$/.exec(authHeader);
    if (!m) { res.status(401).json({ ok: false, reason: "missing bearer token" }); return; }
    const decoded = await getAuth().verifyIdToken(m[1]);
    const callerDoc = await db.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== "admin") {
      res.status(403).json({ ok: false, reason: "admin only" });
      return;
    }
    const targetUid = (req.body && req.body.uid) || "";
    if (!targetUid) { res.status(400).json({ ok: false, reason: "missing uid" }); return; }
    const targetDoc = await db.collection("users").doc(targetUid).get();
    if (!targetDoc.exists) { res.status(404).json({ ok: false, reason: "user not found" }); return; }
    const target = targetDoc.data();
    const tokens = target.fcmTokens || [];
    if (!tokens.length) { res.status(200).json({ ok: false, reason: "no-token" }); return; }
    const callerName = callerDoc.data().displayName || callerDoc.data().email || "管理員";
    const body = `這是 ${callerName} 從推播控制台發送的測試訊號，收到代表這支裝置的推播設定正常`;
    await sendPush(tokens, "測試推播", body);
    await writePushLog([targetUid], "測試推播", body);
    res.status(200).json({ ok: true, tokenCount: tokens.length });
  } catch (e) {
    logger.error("測試推播失敗", e);
    res.status(500).json({ ok: false, reason: String(e && e.message || e) });
  }
});

/* =========================================================
   12) 急診待命：一鍵緊急動員廣播
   卡片上「右滑發送」滑動條滑到底時呼叫。依醫務所地點自動篩選收件人——
   跟前端 index.html 的 ER_STANDBY_LOCATIONS 是同一份地點清單，這裡另外
   維護一份「這個地點要通知誰」對照表，因為這條規則只有這支函式在用，
   不屬於前端 ER_STANDBY_LOCATIONS 本身的資料：
   - 成功北醫務所：營部（hq）／第一連（co1），加上不分單位的 admin／高勤官。
   - 精北醫務所：第二連（co2），加上不分單位的 admin／高勤官。

   觸發權限不是看角色（admin/高勤官/主官管），而是看「這個人是不是目前
   這班待命勤務指派的車長／駕駛／值班醫官」——跟前端 index.html 的
   isCurrentDutyMember() 同一套判斷依據：這是現場人員自己回報真的有狀況，
   不是後方指揮層級代為觸發，所以比對呼叫者的 displayName 是否等於這筆
   任務的 crewLeader／driver／dutyOfficer 欄位，跟角色完全無關。前端已經
   用同一個條件擋掉不相關的人不會看到這顆滑動條，這裡在後端重新驗證一次
   （不能只信任前端隱藏，前端隱藏繞得過去，後端這關繞不過去）。
   ========================================================= */
const EMERGENCY_BROADCAST_TARGETS = {
  chenggongbei: { label: "成功北醫務所", units: ["hq", "co1"] },
  jingbei: { label: "精北醫務所", units: ["co2"] },
};
function isCurrentDutyMember(displayName, task) {
  if (!displayName || !task) return false;
  return displayName === task.crewLeader || displayName === task.driver || displayName === task.dutyOfficer;
}
async function resolveEmergencyBroadcastRecipients(units) {
  const snap = await db.collection("users").get();
  const recipients = [];
  snap.forEach((doc) => {
    const u = doc.data();
    const role = normalizeRole(u.role);
    const isBroad = role === "admin" || role === "duty_officer";
    const isUnitMatch = units.includes(u.unit) && role !== "pending" && role !== "disabled" && role !== "unclaimed";
    if (!isBroad && !isUnitMatch) return;
    const tokens = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    recipients.push({ uid: doc.id, name: u.displayName || u.email || "未命名人員", tokens });
  });
  return recipients;
}
exports.sendEmergencyBroadcast = onRequest({ cors: true }, async (req, res) => {
  try {
    const authHeader = req.get("Authorization") || "";
    const m = /^Bearer (.+)$/.exec(authHeader);
    if (!m) { res.status(401).json({ ok: false, reason: "missing bearer token" }); return; }
    const decoded = await getAuth().verifyIdToken(m[1]);
    const callerDoc = await db.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists) { res.status(403).json({ ok: false, reason: "insufficient permission" }); return; }
    const locationKey = (req.body && req.body.locationKey) || "";
    const target = EMERGENCY_BROADCAST_TARGETS[locationKey];
    if (!target) { res.status(400).json({ ok: false, reason: "unknown location" }); return; }
    const recSnap = await db.collection("erStandby").doc(locationKey).get();
    const currentTaskId = recSnap.exists ? recSnap.data().currentTaskId : null;
    const taskSnap = currentTaskId ? await db.doc(`tasks/${currentTaskId}`).get() : null;
    const task = taskSnap && taskSnap.exists ? taskSnap.data() : null;
    if (!isCurrentDutyMember(callerDoc.data().displayName, task)) {
      res.status(403).json({ ok: false, reason: "insufficient permission" });
      return;
    }
    const recipients = await resolveEmergencyBroadcastRecipients(target.units);
    const timeStr = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    const title = "🚨 醫務所緊急狀況通報";
    const body = `${target.label} 目前有急診案件，請留職主官與相關人員立即前往現地了解情況並回報。發送時間：${timeStr}`;
    // 確認彈窗要列的「已成功發送的人員名單」只算真的有裝置 token 的人
    // （跟原本行為一致）；但通知中心的個人紀錄（pushLog）涵蓋整個對應
    // 單位的所有人，不管當下有沒有裝置能收到即時推播，之後打開系統還是
    // 看得到這則通知。
    const pushable = recipients.filter((r) => r.tokens.length);
    if (await isTestModeActive()) {
      logger.info("測試模式開啟中，略過緊急動員廣播實際發送");
      res.status(200).json({ ok: true, message: body, recipients: [], testMode: true });
      return;
    }
    await sendPush(pushable.flatMap((r) => r.tokens), title, body);
    await writePushLog(recipients.map((r) => r.uid), title, body);
    res.status(200).json({ ok: true, message: body, recipients: pushable.map((r) => r.name) });
  } catch (e) {
    logger.error("緊急動員廣播失敗", e);
    res.status(500).json({ ok: false, reason: String(e && e.message || e) });
  }
});

/* =========================================================
   13) 登入救援：Google 帳號登入卡住/失效時（見「登入」相關的 BUILD_TAG
   歷史紀錄，有時候彈出視窗會整個卡住進不去），用登記的電話號碼＋信箱
   驗證碼換一次性的臨時通行權杖直接登入該帳號，不需要管理員介入，也
   不用發簡訊（不需要額外的付費簡訊服務或 Firebase Phone Auth 設定）。

   流程：
   1) requestLoginRecoveryCode：前端還沒登入，只帶電話號碼呼叫。比對
      users 集合裡 phone 完全相符、且帳號是在職狀態（不是 pending／
      disabled／unclaimed）的帳號——剛好一筆才繼續，找不到或超過一筆都
      當作查無帳號處理（電話號碼理論上不該重複，這裡防呆，寧可不寄信
      也不要寄錯人）。產生 6 位數驗證碼，只存雜湊值（不存明碼），寫入
      loginRecoveryCodes/{uid}，10 分鐘後過期；寄一封信到該帳號登記的
      Google 信箱——不是輸入電話號碼的人看得到。這就是這個機制安全性的
      關鍵：光憑「知道同事的電話號碼」沒辦法冒充登入，驗證碼一定要進
      得去本人的信箱才拿得到。回應內容故意不透露「這支電話有沒有查到
      帳號」，一律回同一句話，避免這支端點被拿來反查誰的電話號碼有登記
      在系統裡。60 秒內同一個帳號不重複寄信，避免被拿來洗爆某人的信箱。
   2) verifyLoginRecoveryCode：帶電話號碼＋驗證碼呼叫。重新比對一次
      電話號碼找到 uid，比對 loginRecoveryCodes/{uid} 的雜湊值、是否
      過期、是否已使用過、錯誤次數是否超過上限（5 次）；通過就核發
      Firebase 自訂權杖，前端用 signInWithCustomToken 直接登入這個帳號，
      驗證碼同時標記為已使用（單次有效，符合使用者要求）。

   信件寄送用 nodemailer 走 SendGrid 的 SMTP relay（不是 Gmail SMTP：
   寄件帳號 paul25042505@gmail.com 本身停用了應用程式密碼——帳號開了
   進階保護計畫或類似的組織限制，Google 帳戶設定裡完全不會顯示「應用
   程式密碼」這個選項，這條路走不通），改用 SendGrid 的「Single Sender
   Verification」驗證這個信箱當寄件者，不需要自己的網域、不用設定
   DNS。API Key 存在 Cloud Functions 密鑰 SENDGRID_API_KEY（見
   firebase functions:secrets:set），不會出現在原始碼或 Git 版本紀錄
   裡；寄件信箱本身（RECOVERY_SENDER_EMAIL）不是密鑰，直接寫在原始碼
   沒有安全疑慮。
   ========================================================= */
const SENDGRID_API_KEY = defineSecret("SENDGRID_API_KEY");
const RECOVERY_SENDER_EMAIL = "paul25042505@gmail.com";
const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000; // 10 分鐘
const RECOVERY_CODE_COOLDOWN_MS = 60 * 1000; // 同一個帳號 60 秒內不重複寄信
const RECOVERY_MAX_ATTEMPTS = 5;

function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}
let mailTransporter = null;
function getMailTransporter() {
  if (!mailTransporter) {
    // SendGrid SMTP relay：帳號固定是字面上的 "apikey" 這個字串，密碼
    // 才是真正的 API Key，跟一般 SMTP 帳密的用法不太一樣，是 SendGrid
    // 自己的慣例。
    mailTransporter = nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      secure: false,
      auth: { user: "apikey", pass: SENDGRID_API_KEY.value() },
    });
  }
  return mailTransporter;
}
// 依電話號碼找在職帳號：剛好一筆才算找到，找不到或不只一筆都當作查無
// 帳號（見上面說明）。
async function findActiveUserByPhone(phone) {
  const snap = await db.collection("users").where("phone", "==", phone).get();
  const candidates = snap.docs.filter((doc) => {
    const role = normalizeRole(doc.data().role);
    return role !== "pending" && role !== "disabled" && role !== "unclaimed";
  });
  if (candidates.length !== 1) return null;
  return candidates[0];
}
exports.requestLoginRecoveryCode = onRequest({ cors: true, secrets: [SENDGRID_API_KEY] }, async (req, res) => {
  // 回應內容故意不透露「這支電話有沒有查到帳號」，一律回同一句話——
  // 不然這支端點會變成拿電話號碼反查誰的資料有登記在系統裡的管道，
  // 包含寄信本身失敗的情況也一樣（見下面 catch）。
  const genericResponse = { ok: true, message: "如果這支電話號碼有對應的帳號，驗證碼已經寄到該帳號登記的信箱" };
  try {
    const phone = String((req.body && req.body.phone) || "").trim();
    if (!phone) { res.status(200).json(genericResponse); return; }
    const userDoc = await findActiveUserByPhone(phone);
    if (!userDoc) { res.status(200).json(genericResponse); return; }
    const uid = userDoc.id;
    const email = userDoc.data().email;
    if (!email) { res.status(200).json(genericResponse); return; }
    const existing = await db.collection("loginRecoveryCodes").doc(uid).get();
    if (existing.exists) {
      const d = existing.data();
      const createdAtMs = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0;
      if (Date.now() - createdAtMs < RECOVERY_CODE_COOLDOWN_MS) { res.status(200).json(genericResponse); return; }
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const now = new Date();
    await db.collection("loginRecoveryCodes").doc(uid).set({
      codeHash: hashRecoveryCode(code),
      createdAt: now,
      expiresAt: new Date(now.getTime() + RECOVERY_CODE_TTL_MS),
      used: false,
      attempts: 0,
    });
    const displayName = userDoc.data().displayName || "";
    await getMailTransporter().sendMail({
      from: `衛生營車輛人員動態管制系統 <${RECOVERY_SENDER_EMAIL}>`,
      to: email,
      subject: "登入驗證碼",
      text: `${displayName ? displayName + "，" : ""}您的登入驗證碼是：${code}\n\n10 分鐘內有效，用於在登入頁「無法登入？」流程直接登入您的帳號。\n\n如果不是您本人操作，請忽略這封信件；有疑慮請聯繫系統管理員。`,
    });
    logger.info(`登入救援驗證碼已寄出：帳號 ${uid}（電話比對成功）`);
    res.status(200).json(genericResponse);
  } catch (e) {
    logger.error("登入救援驗證碼寄送失敗", e);
    res.status(200).json(genericResponse);
  }
});
exports.verifyLoginRecoveryCode = onRequest({ cors: true }, async (req, res) => {
  try {
    const phone = String((req.body && req.body.phone) || "").trim();
    const code = String((req.body && req.body.code) || "").trim();
    if (!phone || !code) { res.status(400).json({ ok: false, reason: "missing phone or code" }); return; }
    const userDoc = await findActiveUserByPhone(phone);
    if (!userDoc) { res.status(400).json({ ok: false, reason: "invalid-code" }); return; }
    const uid = userDoc.id;
    const codeRef = db.collection("loginRecoveryCodes").doc(uid);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) { res.status(400).json({ ok: false, reason: "invalid-code" }); return; }
    const d = codeSnap.data();
    const expiresAtMs = d.expiresAt && d.expiresAt.toMillis ? d.expiresAt.toMillis() : 0;
    if (d.used || Date.now() > expiresAtMs) { res.status(400).json({ ok: false, reason: "invalid-code" }); return; }
    if ((d.attempts || 0) >= RECOVERY_MAX_ATTEMPTS) { res.status(400).json({ ok: false, reason: "too-many-attempts" }); return; }
    if (hashRecoveryCode(code) !== d.codeHash) {
      await codeRef.update({ attempts: (d.attempts || 0) + 1 });
      res.status(400).json({ ok: false, reason: "invalid-code" });
      return;
    }
    await codeRef.update({ used: true });
    const token = await getAuth().createCustomToken(uid);
    logger.info(`登入救援驗證成功：帳號 ${uid} 核發臨時通行權杖`);
    res.status(200).json({ ok: true, token });
  } catch (e) {
    logger.error("登入救援驗證失敗", e);
    res.status(500).json({ ok: false, reason: String(e && e.message || e) });
  }
});

// 純函式/資料存取邏輯額外匯出一份，方便寫單元測試直接呼叫驗證（不會
// 影響部署——firebase deploy 只認得用 onDocumentCreated 等 v2 trigger
// builder 包起來的 exports，這個純物件會被忽略，不會變成多一個雲端函式）。
exports._internal = { normalizeRole, resolveRecipients, resolveAllTokens, isVitalsDanger, gcsTotalFromString, claimEventOnce, standbyShiftCutoff, resolveEmergencyBroadcastRecipients, isCurrentDutyMember, writePushLog, notifyRecipients, isTestModeActive, buildDailyWeatherBody, runDailyWeatherReport, hashRecoveryCode, findActiveUserByPhone };
