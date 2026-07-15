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

   收件人規則：前三個觸發＋待命車換班提醒依單位隔離，跟前端 RBAC 一致——
   高勤官／admin 收全單位的通知，主官管／一般成員只收自己單位的；公告是
   全體公告，沒有單位隔離，不分單位推給所有在職帳號（見 resolveAllTokens）。

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
const { getAuth } = require("firebase-admin/auth");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const logger = require("firebase-functions/logger");

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
   緊急動員廣播——這些「發給大家」的推播（含個人通知中心紀錄 pushLog）
   都會略過。「推播控制台」的單人測試推播（sendTestPush）刻意不受
   影響：那是管理員自己選定單一對象、確認裝置設定是否正常的診斷工具，
   不是「打擾大家」的通知，測試模式開著時如果連這個都失效，反而讓
   管理員搞不清楚裝置設定本身到底有沒有問題。
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
   4) 公告新增（訊息管理 → 新增公告）：只有新增才推播，編輯/刪除不重推，
   避免同一則公告被改個字就再打擾大家一次。isRead 標記已讀是前端另外
   直接寫 Firestore 的動作，不會新增文件，不會誤觸這個 trigger。
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
   10) 推播控制台：管理員手動測試推播
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
   11) 急診待命：一鍵緊急動員廣播
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

// 純函式/資料存取邏輯額外匯出一份，方便寫單元測試直接呼叫驗證（不會
// 影響部署——firebase deploy 只認得用 onDocumentCreated 等 v2 trigger
// builder 包起來的 exports，這個純物件會被忽略，不會變成多一個雲端函式）。
exports._internal = { normalizeRole, resolveRecipients, resolveAllTokens, isVitalsDanger, gcsTotalFromString, claimEventOnce, standbyShiftCutoff, resolveEmergencyBroadcastRecipients, isCurrentDutyMember, writePushLog, notifyRecipients, isTestModeActive };
