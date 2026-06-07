# SPEC.md — SRT字幕修復ツール v0.1.0

## 1. 概要

本アプリは、DeepLなどで翻訳したSRT字幕ファイルのフォーマット崩れを修復するためのWindowsデスクトップGUIツールである。

**元の英語SRTを正本として扱い、番号・タイムコード・字幕ブロック構造は元SRTから復元し、翻訳済みSRTからは翻訳本文だけを取り出して差し戻す**ことを基本方針とする。

AIは補助的に用いる。機械的に修復できない箇所（翻訳欠落など）に対して、一括翻訳補完または個別再補完を行う。

技術スタック: Rust + TypeScript + React + Tauri 2

---

## 2. 解決する問題

DeepL Web版などでSRTファイルを翻訳すると、以下のような問題が起こることがある：

- 字幕番号が消える／本文と同じ行に入る
- タイムコード行が崩れる／`-->` の形式が壊れる
- 空行が消え、複数の字幕ブロックが結合される
- 1つの字幕ブロックが分割される
- 翻訳文の中にタイムコードや番号が混ざる
- SRTとして再生ソフトに読み込めなくなる

---

## 3. アーキテクチャ

### 3.1 ディレクトリ構成

```
src-tauri/          Rustバックエンド (Tauri)
  src/
    lib.rs          全Tauriコマンド定義
    main.rs         エントリポイント
    types.rs        全データ型定義
    parser.rs       元SRTの厳密パース
    loose_parser.rs 翻訳SRTのゆるいパース
    repair.rs       修復アルゴリズム
    llm_repair.rs   AI翻訳バッチ処理
    output.rs       SRT出力生成
    env_config.rs   環境変数設定読み書き
  Cargo.toml
  tauri.conf.json

src/                TypeScriptフロントエンド (React)
  App.tsx           ルートコンポーネント・状態管理
  App.css           全スタイル
  types.ts          フロントエンド型定義（Rust型のミラー）
  main.tsx          エントリポイント
  components/
    FileSelector.tsx          ファイル選択
    RepairControls.tsx        修復開始ボタン・AI状態表示
    RepairSummary.tsx         修復結果サマリー
    NeedsReviewList.tsx       要確認cue一覧・個別AI再補完
    BatchRepairPanel.tsx      一括AI修正パネル（状態遷移あり）
    LlmSettings.tsx           AI設定ダイアログ
    RepairLogWindow.tsx       修復ログ表示ウィンドウ
```

### 3.2 Tauriコマンド一覧

| コマンド | 説明 |
|---------|------|
| `repair_and_save_srt` | 2つのSRTを読み込み修復、結果サマリーを返す |
| `get_llm_config` | 保存済みAI設定を読み込み |
| `scan_llm_providers` | 全プロバイダのAPIキー検出状態を返す |
| `save_llm_config` | AI設定を保存 |
| `delete_llm_config` | AI設定を削除 |
| `test_llm_connection` | AI APIへの接続テスト（JSON形式検証含む） |
| `batch_translate_cues` | 複数cueを一括AI翻訳 |
| `save_repaired_srt` | 採用cueのみを新しいSRTファイルに保存（上書きなし） |
| `predict_llm_output_path` | 保存先パスを事前表示 |
| `open_file` | OS標準アプリでファイルを開く |
| `open_folder` | エクスプローラでフォルダを開く |
| `copy_to_clipboard` | クリップボードにコピー |

---

## 4. データモデル

### 4.1 SourceCue（元SRTから厳密パース）

```rust
pub struct SourceCue {
    pub id: u32,         // 字幕番号
    pub index: usize,    // パース順序（0-based）
    pub start: String,   // 開始時刻 "HH:MM:SS,mmm"
    pub end: String,     // 終了時刻
    pub text: String,    // 英語本文（複数行可）
}
```

### 4.2 TranslationCue（翻訳SRTからゆるくパース）

```rust
pub struct TranslationCue {
    pub raw_index: usize,
    pub possible_id: Option<u32>,
    pub possible_start: Option<String>,
    pub possible_end: Option<String>,
    pub text: String,
    pub confidence: f64,
}
```

### 4.3 RepairedCue（出力用）

```rust
pub struct RepairedCue {
    pub id: u32,
    pub start: String,
    pub end: String,
    pub source_text: String,
    pub translated_text: String,
    pub status: RepairStatus,
    pub confidence: f64,
    pub notes: Option<String>,
}
```

### 4.4 RepairStatus

```rust
pub enum RepairStatus {
    AutoMatched,         // 位置が完全一致
    StructureRecovered,  // 構造は壊れていたが本文を復元
    LLMRepaired,         // AIで修復
    NeedsReview,         // 要確認
    Unmatched,           // 翻訳見つからず
}
```

### 4.5 RepairSummary（修復結果）

```rust
pub struct RepairSummary {
    pub total_cues: usize,
    pub auto_matched: usize,
    pub structure_recovered: usize,
    pub llm_repaired: usize,
    pub needs_review: usize,
    pub unmatched: usize,
    pub output_path: String,
    pub log_path: String,
    pub llm_failed: bool,
    pub needs_review_cues: Vec<RepairedCue>,
    pub llm_failed_cues: Vec<RepairedCue>,
    pub repaired_cues: Vec<RepairedCue>,
    pub log_entries: Vec<RepairLogEntry>,
    pub process_log: Vec<String>,
}
```

### 4.6 BatchRepairCue（AI一括翻訳入力）

```rust
pub struct BatchRepairCue {
    pub id: u32,
    pub source_text: String,
    pub current_translation: String,
    pub context_before: String,   // 前cueの原文（文脈用）
    pub context_after: String,    // 次cueの原文（文脈用）
}
```

### 4.7 BatchRepairResult（AI一括翻訳結果）

```rust
pub struct BatchRepairResult {
    pub id: u32,
    pub source_text: String,
    pub original_translation: String,
    pub llm_translation: String,
    pub confidence: f64,
    pub status: BatchCueStatus,
    pub error: Option<String>,
}

pub enum BatchCueStatus {
    Pending,    // 未確認
    Accepted,   // ユーザーが採用
    Rejected,   // ユーザーが却下
}
```

### 4.8 LlmConfig（AI設定）

```rust
pub struct LlmConfig {
    pub provider: String,     // "openai"|"deepseek"|"minimax"|"kimi"|"custom"
    pub base_url: String,
    pub model: String,
    pub api_key_env: String,  // 環境変数名
    pub configured: bool,     // キー検出済みか
}
```

---

## 5. SRTパース仕様

### 5.1 元SRTの厳密パース（`parser.rs`）

元SRTは正しい構造であることを前提とする。

1 cue の構造：
```
番号
開始時刻 --> 終了時刻
本文（複数行可）
空行
```

時刻形式: `HH:MM:SS,mmm --> HH:MM:SS,mmm`

### 5.2 翻訳SRTのゆるいパース（`loose_parser.rs`）

翻訳後SRTは壊れている可能性があるため、以下のルールで本文を抽出する：

- 数字だけの行 → cue番号候補
- タイムコード形式に近い行 → タイムコード候補
- `-->` を含む行 → タイムコード候補
- それ以外 → 本文候補
- 空行がない場合も番号行・タイムコード行を境界として推定
- 本文中に混入した番号・タイムコードは除去候補

---

## 6. 修復アルゴリズム（`repair.rs`）

### 6.1 全体の流れ

```
元SRTを厳密にパース
↓
翻訳SRTをゆるくパース
↓
cue数を比較
↓
一致 → 順番で対応づけ（AutoMatched）
↓
不一致 → ずれ範囲を特定、構造復元
↓
AI有効時 → NeedsReview なcueをAI一括翻訳
↓
要確認cue一覧を返す
↓
SRT出力
```

### 6.2 AI修復バッチ処理（`llm_repair.rs`）

- AIには cue ID、原文、既存訳、前後文脈 のみを渡す
- 番号・タイムコード・SRT構造は一切渡さない
- レスポンスは `{"translations": [{"id": N, "translation": "...", "confidence": 0.X}]}` 形式
- `translations` キーがない場合は `cues` キー、それもなければ部分サルベージを試みる
- バッチ単位で失敗しても全体は止めず、失敗cueはエラー付きで返す

---

## 7. GUI仕様

### 7.1 画面構成

```
[SRT字幕修復ツール]

⚙ AIの設定

1. 元の英語SRTファイル [選択]
2. 翻訳後のSRTファイル（DeepL出力） [選択]

3. [修復開始]

4. 修復結果サマリー
   自動修復: N件 / 構造復元: N件 / AI修復: N件
   確認が必要: N件 / 未対応: N件

5. 要確認cue一覧（個別AI再補完ボタン付き）

6. 一括AI修正パネル
   [AI接続テスト] [一括AI修正]
   バッチサイズ選択 → 進捗表示 → プレビュー表
   採用/却下 → [選択したN件を新しいSRTに保存]
   保存後: [ファイルを開く] [フォルダを開く] [パスをコピー]
```

### 7.2 一括AI修正パネルの状態遷移

```
idle → testing → repairing → previewing → saving
```

- **idle**: 接続テスト・一括修正ボタン（テスト成功までdisabled）
- **testing**: 接続テスト中スピナー
- **repairing**: バッチ進捗バー + 中止ボタン
- **previewing**: 翻訳候補テーブル、採用/却下切替、一括選択/解除、失敗分再試行
- **saving**: 保存中スピナー

### 7.3 AI設定画面

- プロバイダ選択（OpenAI / DeepSeek / MiniMax / Kimi / カスタム）
- 各プロバイダのAPIキー検出状態表示
- プロバイダ選択時のモデル・URL自動入力
- 設定保存/削除

---

## 8. 出力仕様

### 8.1 ファイル名

- 構造修復後: `{元ファイル名}_repaired.srt`
- AI一括修正後: `{翻訳ファイル名}-Repaired_after_llm.srt`
- 同名ファイルが存在する場合は連番サフィックス（`_1`, `_2`, ...）
- 保存先は元ファイルと同じディレクトリ

### 8.2 SRT出力形式

```
1
00:00:01,000 --> 00:00:03,000
こんにちは。

2
00:00:04,000 --> 00:00:06,000
私はトムです。
```

- cue番号・タイムコードは元SRTを保持
- 改行はCRLF（Windows向け）
- UTF-8（BOMなし）

---

## 9. AIプロバイダ設定

| プロバイダ | Base URL | 環境変数 |
|-----------|----------|---------|
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| MiniMax | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` |
| Kimi | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` または `KIMI_API_KEY` |
| カスタム | 任意 | `SRT_REPAIR_LLM_API_KEY` |

Kimi のみ `"thinking": {"type": "enabled"}` の追加ボディが送信される。

保存先: Windowsユーザー環境変数（`SRT_REPAIR_LLM_*`）

---

## 10. プライバシー

- 通常の機械修復では外部送信しない
- AI修復を使う場合のみ、問題箇所のcue情報（ID、原文、既存訳、前後文脈）が外部APIへ送信される
- ファイル全体をAIに送信しない
- 字幕本文は原則ログに保存しない

---

## 11. テスト

### 単体テスト（27件）

| カテゴリ | 件数 | 内容 |
|---------|------|------|
| parser | 7 | 正常パース、空ファイル、複数行本文、CRLF、不正番号/タイムスタンプ、空テキスト+空行 |
| loose_parser | 9 | 正常翻訳、壊れた番号、本文中番号混入、タイムスタンプ破損、空白行欠落など |
| repair | 5 | 同数自動マッチ、small mismatch、構造復元、ソース構造保持、mismatch 局所化 |
| output | 3 | 基本SRT生成、複数cue、出力パス |
| env_config | 2 | 設定読み書き削除、未設定ファイル読み取り |

---

## 12. 開発上の重要原則

1. 元SRTの構造を絶対に信頼する
2. 翻訳SRTの番号・タイムコードは信用しない
3. 翻訳SRTからは本文だけを救出する
4. 機械的に直せる部分はAIに渡さない
5. AIには局所的な翻訳補完だけをさせる
6. AIにタイムコード・SRT構造を一切変更させない
7. PCに詳しくない人が使えるGUIにする
8. 失敗時も全体を止めず、確認・手動修正に回す
9. 出力SRTは必ず標準形式に正規化する
10. 字幕本文をログに残さない
---

## 13. バリデーション

### 入力時

- ファイルが存在する
- 空でない
- cue番号・タイムコードが検出できる
- 時刻形式が正しい

### 出力前

- cue数が元SRTと一致している
- 全cueに番号・タイムコードがある
- タイムコード形式が正しい
- 未修復cueが残っている場合は警告

---

## 14. 将来拡張

- DeepL APIによる「壊れない翻訳モード」
- 複数SRTの一括修復
- 翻訳メモリ・固有名詞辞書・用語集
- 字幕1行あたり文字数調整
- ASS/VTT形式対応
- macOS対応
- 多言語UI
