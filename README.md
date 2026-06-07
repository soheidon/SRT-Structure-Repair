# SRT字幕修復ツール v0.1.0

SRT字幕ファイルのフォーマット崩れを修復するWindowsデスクトップアプリです。
Tauri 2 + Rust + React/TypeScript で構築されています。

## 概要

DeepLなどで翻訳したSRT字幕ファイルは、翻訳自体は良好でも以下のような問題が起こることがあります：

- 字幕番号が消える、または本文と同じ行に入る
- タイムコード行が崩れる
- 空行が消えて複数字幕ブロックが結合される
- `-->` の形式が壊れる
- 翻訳文の中にタイムコードや番号が混ざる

本ツールは**元の英語SRTを正本**として、番号・タイムコード・字幕ブロック構造を復元し、翻訳後SRTから翻訳本文だけを取り出して差し戻します。

## 主な機能

### 構造修復
- 元SRTと翻訳後SRTの自動対応づけ
- 番号・タイムコード崩れの自動復元
- 結合・分割された字幕の検出と修復
- 要確認箇所の一覧表示

### AI翻訳補完
- 翻訳が欠落した字幕の一括AI補完
- OpenAI / DeepSeek / MiniMax / Kimi / カスタム に対応
- 接続テスト → 一括翻訳 → プレビュー → 採用分だけ保存 の安全なフロー
- 1件ずつの個別再補完にも対応

## 動作環境

- Windows 10/11
- [Microsoft Edge WebView2](https://developer.microsoft.com/ja-jp/microsoft-edge/webview2/)（通常はOSに組み込み済み）

## インストール

[Releases](https://github.com/soheidon/SRT-Structure-Repair/releases) から `.msi` インストーラーをダウンロードしてください。

## ビルド方法

### 前提

- [Rust](https://www.rust-lang.org/tools/install)
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://v2.tauri.app/)

### 手順

```bash
npm install
npm run tauri build
```

ビルド成果物は `src-tauri/target/release/bundle/` に生成されます。

### 開発

```bash
npm run tauri dev
```

## 使い方

1. 「元の英語SRTファイル」を選択
2. 「翻訳後のSRTファイル（DeepL出力）」を選択
3. 必要に応じて「AIの設定」でAPIキーを設定
4. 「修復開始」をクリック
5. 修復結果を確認し、必要ならAIで翻訳補完
6. 保存して完了

## AI設定

AI機能を使うには、使用するプロバイダのAPIキーを環境変数に設定する必要があります：

| プロバイダ | 環境変数 |
|-----------|---------|
| OpenAI    | `OPENAI_API_KEY` |
| DeepSeek  | `DEEPSEEK_API_KEY` |
| MiniMax   | `MINIMAX_API_KEY` |
| Kimi      | `MOONSHOT_API_KEY` または `KIMI_API_KEY` |
| カスタム  | `SRT_REPAIR_LLM_API_KEY` |

## 技術スタック

- **フロントエンド**: React 18 + TypeScript + Vite
- **バックエンド**: Rust + Tauri 2
- **HTTP**: reqwest + tokio
- **クリップボード**: arboard

## ライセンス

MIT
