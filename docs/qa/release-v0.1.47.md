# v0.1.47 發布前核對

狀態：發版文章與內容盤點已備妥，尚未達到可打 tag 狀態。維護者已授權合併可驗收的 PR，
未授權發布，文件 PR 維持 Draft。#103 已依維護者授權先合併完成部分；這不代表剩餘 QA 通過，
文件 PR 的 CI 也只驗證其實際 checkout。

## 兩個 repo 的版本範圍

- 上一版：public v0.1.46；其 release asset desktop-rev.txt 記錄 private
  `a75104e1ff5cd9b63aece09a326d50ee57b10341`。
- 本轮原先的 private／public pin 基線：`409c0d1901f4bc81b53e6dd405a0f2615bdd5598`。
  private #9／#10 包含圖表指標工具、回測數值基線、1.7.5 bootstrap 與正式 Auto，
  以及 tool permission／內容 approval ID 的修正。private 沒有發版或版本 bump。
- public 已合併：#79 首頁旗標／主題／文件；#81（含 #77）1.7.5、用量監控、
  正式 Harness、圖表指標與 dev identity；#82 設定 UX；#83 重啟前停止 native Agent；
  #84 CI 觸發／取消修正。
- 本次已合併：#108 熱圖冷開／模擬昨餘顯示修正，merge commit
  `2d09d9bccb2f047792814bf8ee09520bbd42f775`，其四項 CI 均 SUCCESS。
- #103 帳務／行情查詢用量及快照一檔已合併，merge commit
  `0e86bd608103748859f0978357d903d83537ff8a`；本 release 分支已 merge 此 main。
  #87、#89–#93、#95–#101、#105 已關閉；#85／#86 的實際 wire、#88／#94 的
  原生異常退出驗收仍開放。#75、#57、#102 保持 OPEN，不列為全面解決。
- #111 子視窗 notification 初始化修正由 private #11／public #112 paired PR 承接，
  private #11 已合併為 `a254e739ddfbf43619c90ca76b2cb0078a14ac7d`。
  public #112 已 repin 此 merge SHA（head `24df2a6`），重跑完整 CI 後合併。
  release 分支同步該候選 pin；paired 尚未完整落地前不能打 tag。
- RELEASE_NOTES.md 沿用 v0.1.46／v0.1.45 的版本標題、功能段落、驗證範圍與
  結尾風險／下載格式；只寫預計 v0.1.47，不修改 package/Cargo/Tauri 版本。

## 已取得證據

- private #10 真正 desktop-ci：
  [34689974496](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34689974496) 成功；
  private 先 merge、public repin 與合成 CI、public #81 merge 的順序已完成。
- #103 合併前 head `a5891bc998e13b2e35679e48558bcdac8baf60ca` 的完整 checks 全部 SUCCESS：
  [34807942449](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34807942449)、
  [34807942195](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34807942195)、
  [34807942205](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34807942205)。
  合併完成不等於實際 broker wire 或原生異常退出 gate 完成。
- private #11 真正 desktop-ci
  [34809395865](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34809395865) SUCCESS。
  public #112 head `2773987a` 的必要 CI、web 與 Linux/Windows 合成
  [34809442757](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34809442757)
  四項均 SUCCESS。repin 後 `24df2a6` 的完整 CI 另見 PR，不沿用前一 head。
- 本機 #103 pinned overlay：69 檔／575 tests、tsc -b／Vite build 通過。
  #108 main-based 拆分：58 檔／509 tests、build 通過，另有獨立 source QA。
- macOS arm64 既有原生 dev App／1.7.5 模擬 sidecar：帳戶分頁更新隔離、
  估算持倉隨行情更新、快照第一檔、熱圖兩次冷開、昨餘未知提示、SSE LIVE 與 heartbeat。
  此為先前 dev · 57846951 的歷史證據，不涵蓋其後發現的 #111 啟動錯誤。
- #111 修正後重新建置的原生 dev · 2773987a／1.7.5 模擬 sidecar 為 LIVE；
  首個 3374 熱圖小視窗冷開不需 resize 即正常繪圖、無 fatal。第二次測試因使用者
  操作切換焦點而未完成，不算第二次通過，也不宣稱所有子視窗已驗收。
- Claude CLI 已實際修正 QA 發現的資訊回應競爭並補回歸；獨立 code-review agent
  與 QA agent 驗收。Mock、實際 sidecar 唯讀與 native UI 證據分開記錄。

## 尚未完成的 gate

1. #103 的實際 broker 委託／成交 wire 回歸與原生回報路徑。現有 callback schema
   來自真 1.7.5 OpenAPI，但測試事件仍是合成資料，不能冒充實际 broker 回報。
2. #108／#103 已合併；#88／#94 原生異常退出仍待驗收。完成 #111 子視窗冷開驗收
   與 public #112 repin 後完整 CI；private #11 已先 merge，public 已 repin 到 private
   merge SHA，Linux／Windows 合成 CI 完整成功後再 merge。release 分支已合入
   該共享候選 commit，最終檢查其與 public main 的差异及完整 CI。每個 PR 一律 merge commit。
3. Fresh native Codex／Claude／Pi 的正式唯讀、proposal deny/expiry、Auto deny/revoke、
   帳戶／環境／runtime lifecycle；成功派送用隔離 broker fixture，不送正式單。
4. macOS arm64/x64、Windows、Linux 原生 bootstrap／approval／Dashboard，以及
   乾淨機器 onboarding。既有 Mac 與 CI 不能代替其他平台或乾淨機器。
5. 最終 public main 與 private pin 一致、無失敗／取消／pending check；維護者另行
   明確批准 public main 的 v0.1.47 tag。不得沿用 v0.1.46 的 QA 豁免。

發布時由 tag workflow 建置與上傳；發布後依 docs/RELEASE.md 驗證 18 個 assets、
11 個 latest.json 平台 key、簽章與 desktop-rev.txt。現在沒有建立任何 tag／release。
