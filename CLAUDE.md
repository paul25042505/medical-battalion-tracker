# 專案筆記

單一 HTML 檔案（`index.html`）的 vanilla JS + Firebase 應用，無建置流程，
透過 GitHub Actions 部署到 Firebase Hosting + Firestore Rules。

## 出貨檢查清單（每次 PR 都要做）

1. 修改 `index.html`
2. Bump `BUILD_TAG`（格式 `"YYYY-MM-DD-NN-短描述"`）
3. 在 `RELEASE_NOTES`（`index.html` 內，`FEEDBACK_CATEGORY_LABEL` 附近）補一筆
   當天的異動摘要——同一天有多筆出貨就更新同一筆日期的 `summary`，不要
   重複開新的日期項目。這樣「關於系統 → 更新紀錄」才會跟著實際出貨內容走。
   - 系統版本／Build／發布日期／最後更新已經改成從 `BUILD_TAG` 自動解析
     （見 `appVersion()`／`buildTagDate()`）。系統版本是「主.次.修訂」
     （`APP_MAJOR_MINOR` + BUILD_TAG 流水號），修訂號每次出貨自動加一，
     主/次版號只有重大改版才需要手動調整 `APP_MAJOR_MINOR`——判斷標準見
     下方「主/次版號怎麼判斷」。
4. `node --check` 驗證抽出的 `<script type="module">` 語法
5. 用 Playwright 對照修改到的畫面做離線驗證（複製到 scratchpad、抽掉
   Firebase import、注入 debug hook 後開瀏覽器測試）；牽涉到互動元件
   （按鈕、連結、表單送出）時，要實際模擬點擊並確認結果（例如導覽後
   路由真的變了），不能只檢查畫面上有沒有渲染出文字/元素——只查渲染
   結果會漏掉像是 onclick 屬性裡雙引號互相截斷這種「畫面看起來正常、
   點下去沒反應」的 bug。
6. commit → rebase origin/main → push → 開 PR → squash merge

## 主/次版號怎麼判斷（`APP_MAJOR_MINOR`）

修訂號（第三碼）全自動，不用管。主／次版號（前兩碼）出貨時照下面判斷，
不符合任何一條就不用動：

- **次版號 +1**：這次出貨新增了一個完整的功能模組/頁面，或對既有功能有
  明顯擴充，但沒有破壞既有資料相容性。例如：意見回饋系統、關於系統頁、
  現場狀況分類、車輛跨單位借用這類等級的改動。
- **主版號 +1（次版號歸零）**：整個介面重新設計、資料結構有破壞性遷移
  （舊資料要轉換才能繼續用）、或核心框架/架構整個換掉。目前還沒發生過。
- 單純的 bug 修正、文字調整、樣式微調、重構——不算，維持原本的
  `APP_MAJOR_MINOR` 不動。
