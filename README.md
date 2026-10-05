# claude-code-mods

oioi555 の Claude Code mod 置き場。このリポジトリ自体が Marketplace (`oioi555`) になっている。

| mod | 内容 |
| --- | --- |
| [cache-keeper](plugins/cache-keeper/) | コンテキスト・クォータ・プロンプトキャッシュのメーター。1時間キャッシュのアイドル中は keep-alive と compact を自動で行い、その間スリープを抑止する (Linux / Windows / macOS) |

## 別のPCへのセットアップ

Claude Code 2.1.287 以降 (mod が既定で有効)。

```sh
claude plugin marketplace add oioi555/claude-code-mods
claude plugin install cache-keeper@oioi555
```

private リポジトリなので、そのPCで `gh auth login` か GitHub への SSH 鍵が通っていること。

更新:

```sh
claude plugin marketplace update oioi555
claude plugin update cache-keeper@oioi555
```

起動中のセッションには `/reload-plugins` で反映される。

### 一緒に入れていたものとの関係

cache-keeper は次の mod の役割をまとめて置き換える。重複表示になるので無効にしておく。

- `cache-ttl-compact@oikawa-local` (旧版。cache-keeper 0.3.0 の前身)
- `prompt-cache-control@skills-dir` (キャッシュメーター)
- `usage-meter@claude-mods` (コンテキスト・クォータメーター)

## 開発

このPCでは作業コピーそのものを Marketplace として登録してある (`claude plugin marketplace add ~/git/claude-code-mods`)。フォルダ型の Marketplace は作業コピーから直接読まれるので、編集後は `/reload-plugins` だけで反映される。

```sh
claude plugin validate plugins/cache-keeper
claude plugin test plugins/cache-keeper
# 1セッションだけホットリロード付きで試す
claude --plugin-dir plugins/cache-keeper
```

型の定義 (`.claude-plugin/types/`) は Claude Code が mod を読み込むたびに書き出す。`plugins/cache-keeper/tsconfig.json` がそれを参照するので、一度読み込ませたあとは `npx -p typescript tsc -p plugins/cache-keeper` で型チェックできる。
