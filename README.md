# ST-Voice-Clone · Fish Audio 雲端版

SillyTavern / 手機 TT 酒館的語音克隆擴充（純雲端）。

- 只使用 **Fish Audio Reference ID**，不需要本地音檔、不需要 GPT-SoVITS、不需要後端插件。
- 每個 Reference ID 就是一個**角色音色**，存在音色庫，可直接在台詞旁或「角色指派」分頁指派。
- 支援台詞格式：`【角色名】台詞【/角色名】`
- 功能：自動翻譯成日文、上一則／下一則、全部連播、重播、重配、本地快取（IndexedDB）、新訊息自動配音。

## 安裝

1. 在 SillyTavern／TT 酒館 → **擴充功能 → Install Extension**，貼上本倉庫網址：
   `https://github.com/toro55880/ST-Voice-Clone`
2. 到 **擴充功能 → Voice Clone (Fish Audio 雲端)** 勾選啟用。

## 設定

1. 「語音庫 & 設定」分頁填入 **API Key**（API URL 預設即可）。
2. 在「音色庫」填入 **角色名稱** 與 **Reference ID**，按「新增」。
3. 按 ★ 設定預設音色（未指派角色時使用）。
4. 「角色指派」或「台詞配音」分頁為每個角色選擇音色。

## 注意

- 快取存在瀏覽器 IndexedDB，只在該瀏覽器有效；可在設定頁清除。
- 角色指派存在擴充設定中，不會寫入角色卡。
