# weekly-planYou-sqlite

週案日誌 SQLite対応版

## 目的
週案日誌のソースコードと変更履歴をGitHubで管理し、今後のメンテナンスや機能追加に利用する。

## サーバー上の配置
- C:\Yserver\apps\weekly-planYou-sqlite：アプリ本体
- C:\Yserver\lib：API関連処理
- C:\Yserver\scripts：インストール・検証用
- C:\Yserver\server-test.js：テスト用サーバー
- C:\Yserver\package.json：依存ライブラリの管理
- C:\Yserver\package-lock.json：依存ライブラリのバージョン管理

## GitHubに登録しないもの
- node_modules
- 実際のSQLiteデータベース
- ログ・バックアップ
- 個人情報や認証情報

## メンテナンス方針
- 動作確認済みの完成版を基準とする。
- 修正時は変更内容をGitHubに記録する。
- フォルダー構成を変更した場合は、このREADMEも更新する。
- 開発前に現在のフォルダー構成を確認する。
