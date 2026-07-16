/* =========================================================
   離線快取（PWA App Shell）
   這個 App 本質上是即時資料應用（勤務/患者紀錄都要 Firestore 連線才有
   意義），這裡不做「離線也能寫入資料」那種完整離線優先架構——目標只是
   「營區地下室/收訊死角這種暫時斷網的情況，至少打得開 App、看得到上次
   讀到的畫面」，不要整頁變成瀏覽器的離線錯誤頁。

   這段刻意放在檔案最前面、且不依賴下面 Firebase Messaging 的初始化——
   下面 importScripts 現在雖然改成同源的 vendor/firebase/ 檔案（見下面
   說明），還是包一層防護：如果檔案本身讀取失敗，快取邏輯放在它後面又
   沒有防護的話，整支 Service Worker 會直接安裝失敗，離線快取（原本
   應該是「訊號不好時的救援機制」）反而因為這個失敗而跟著一起掛掉。

   CACHE_NAME 只有在下面 PRECACHE_URLS 這份清單本身有增減（例如新增/
   改名圖示檔）時才需要跟著改版號，內容本身不用每次出貨都手動同步——
   /（App Shell 本體）一律是「先打網路，失敗才退回快取」，只要使用者
   有網路，每次都會拿到最新版本，版號只影響「真的離線時退回的那份快取
   多舊」。 */
const CACHE_NAME = "medtrack-shell-v2";
const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/icons/favicon-16.png",
  // Firebase SDK（見下面推播初始化區塊的說明，改成同源自己主機的檔案）
  // 一併列進預先快取，離線時 index.html 裡的 import 才載得到。
  "/vendor/firebase/firebase-app.js",
  "/vendor/firebase/firebase-auth.js",
  "/vendor/firebase/firebase-messaging.js",
  "/vendor/firebase/firebase-app-compat.js",
  "/vendor/firebase/firebase-messaging-compat.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // skipWaiting 讓改版的 SW 不用等所有分頁關閉就直接生效——反正 /
      // 本身一律先打網路，新版 SW 生效不會讓使用者看到舊內容。
      .then(() => self.skipWaiting())
      .catch((err) => console.error("[SW] 預先快取失敗", err))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // 只處理同源的 GET 請求：Firestore／CWA／Open-Meteo／OSRM 這些跨網域
  // 的即時資料 API 完全不攔截，維持原生 fetch 行為，避免快取過期資料
  // 蓋掉即時狀態；PATCH/POST（Firestore 寫入）本來就不該被快取攔截。
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App Shell 本體（導覽/整頁載入）：先打網路拿最新版本，失敗（離線）
  // 才退回快取裡上次成功讀到的版本。
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", resClone));
          return res;
        })
        .catch(() => caches.match("/").then((cached) => cached || caches.match(req)))
    );
    return;
  }

  // 圖示／manifest 這類幾乎不變動的靜態檔案：快取優先，背景重抓一次
  // 更新快取內容，下次離線時才不會拿到太舊的版本。
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

/* =========================================================
   推播通知背景接收（App 沒開著/手機鎖屏時也要能收到）
   這裡是獨立的 Service Worker context，沒辦法跟 index.html 共用 module
   scope，firebaseConfig 只好重複貼一份——這些都是公開的用戶端設定值，
   不是密鑰，重複並不會有安全疑慮。改用 Firebase 的 compat SDK
   （importScripts 載入），因為 Service Worker 對 ES module worker 的
   支援度不像一般網頁那麼一致。

   跟 index.html 的說明一樣，改成同源的 vendor/firebase/ 檔案，不再直接
   連 gstatic.com；仍然包一層 try/catch，理由跟檔案開頭一致——這裡失敗
   不能連帶讓上面已經註冊好的離線快取（install/activate/fetch）跟著一起
   沒有效果。 */
try {
  importScripts("./vendor/firebase/firebase-app-compat.js");
  importScripts("./vendor/firebase/firebase-messaging-compat.js");

  firebase.initializeApp({
    apiKey: "AIzaSyDHJ_ZVLwl9-bD-ZPCTsBcfSjK1A15oJN4",
    authDomain: "medical-battalion-tracker.firebaseapp.com",
    projectId: "medical-battalion-tracker",
    storageBucket: "medical-battalion-tracker.firebasestorage.app",
    messagingSenderId: "442272611220",
    appId: "1:442272611220:web:88ef96f7789200c27ded81"
  });

  const messaging = firebase.messaging();

  // 後端故意送 data（純資料）而不是 notification 欄位，瀏覽器才不會自動
  // 跳一次通知、我們這裡又跳第二次，變成同一則推播收到兩則通知。
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.data && payload.data.title) || "MEDTRACK 通知";
    const body = (payload.data && payload.data.body) || "";
    self.registration.showNotification(title, {
      body,
      icon: "icons/apple-touch-icon.png",
      badge: "icons/favicon-32.png"
    });
  });

  // 點通知時把使用者帶回已經開著的分頁（沒有就開一個新的），不然點了
  // 通知常常會誤以為「沒反應」。
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(
      clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const c of list) { if ("focus" in c) return c.focus(); }
        if (clients.openWindow) return clients.openWindow("/");
      })
    );
  });
} catch (err) {
  console.error("[SW] 推播通知初始化失敗，離線快取不受影響", err);
}
