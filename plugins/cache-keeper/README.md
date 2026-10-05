# cache-keeper

プロンプトの上に2行のメーターを出し、1時間キャッシュのセッションがアイドルになったら、キャッシュが切れる前に keep-alive → compact する mod。

```
ctx ░░░░░░░░░░ 2% 20.5k/1M ▸auto 967k · 5h 28% ↻2h31m · 7d 67% ↻2d5h
● cache 60% ⏱ 59:41 1h · keep-alive 54:41 → compact 1:49:41 · sleep held
```

- 1行目: コンテキスト使用率、Claude Code 本体が自動 compact するトークン数 (`▸auto`)、5時間枠・7日枠の使用率とリセットまでの時間
- 2行目: キャッシュのヒット率、期限までの残り、有効期間 (5m/1h)、keeper の予定、スリープ抑止中か

`/ttl` で詳細ペイン (キャッシュ・コンテキスト・クォータ・keeper の状態、ターンごとの表、操作ボタン) を開く。

| コマンド | 動作 |
| --- | --- |
| `/ttl` | ペインを開く (ボタン: `k` keep-alive now / `c` compact now / `p` pause・resume) |
| `/ttl pause` / `/ttl resume` | このセッションの keeper を止める / 再開する |
| `/ttl now` | すぐ keep-alive する |
| `/ttl compact` | すぐ compact する |
| `/ttl stop` | ペインを閉じる |

## keeper の動き

メインのターンが終わると準備状態になる。キャッシュの寿命は、最後にキャッシュを読み書きしたリクエストの**開始時刻**から数える。

1. 期限の `marginMinutes` 分前 (既定5分) に `$.model.fork()` で tool なしの1文字応答を1回投げる。同じ会話のプレフィックスを読むので、キャッシュの寿命がそこから1時間延びる。
2. これを `keepAlives` 回 (既定1回) 繰り返したら、次の期限前に `$.session.compact()` で同じセッションを compact する。
3. ユーザーがプロンプトを送ると予定は取り消される。

次の場合は何もしない。

- キャッシュの有効期間が5分のとき (APIキー・クラウドプロバイダ・使用量クレジット)。5分ごとの keep-alive は割に合わないため。
- 戻ってきた時点でキャッシュがすでに切れていたとき (スリープしていた等)。そこで keep-alive すると、書き直しの料金を払うだけになる。

### スリープ抑止

予定がある間だけ、OSごとのプロセスを `$.process.spawn` で起動しておく。予定がなくなるかセッションが終わると、そのプロセスを終了して解除する。

| OS | 方法 | 確認 |
| --- | --- | --- |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block` | `systemd-inhibit --list` に `Claude Code cache-keeper` |
| Windows | PowerShell から `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` | 管理者 PowerShell で `powercfg /requests` |
| macOS | `caffeinate -i` | `pmset -g assertions` |

Windows と macOS が止めるのは放置によるスリープだけ。フタを閉じる・手動でスリープさせる、は止められない (Linux の `--mode=block` は手動の suspend も止める)。

## キャッシュの有効期間の判定

`ttl` が `auto` のときは、Claude Code のルールの順に判定する。

1. `FORCE_PROMPT_CACHING_5M` → 5分
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` / `1h`)
3. 設定の `promptCacheTtl`
4. `ENABLE_PROMPT_CACHING_1H` → 1時間
5. サブスクリプション (5時間・7日枠がある) → 1時間。それ以外 → 5分

起動直後はまだクォータが届いていないので、前のセッションで見た枠 (`$.store` に保存) を使う。

そのあとはリクエストの間隔からも補正する。5分以上空いてもキャッシュに当たれば1時間と確定し、5〜60分空いて外れたら5分とみなす。

## 設定

Claude Code の設定メニュー (`/config` の plugin 行) で変更できる。変えると mod が読み込み直される。

| 項目 | 既定 | 内容 |
| --- | --- | --- |
| `ttl` | `auto` | `auto` / `5m` / `1h` |
| `marginMinutes` | 5 | 期限の何分前に keep-alive / compact するか |
| `keepAlives` | 1 | compact までに keep-alive する回数 (0 なら最初の期限前に compact) |
| `keeper` | true | keep-alive と compact を行うか (false ならメーターだけ) |
| `inhibitSleep` | true | 予定がある間スリープを抑止するか |
| `band` | true | プロンプト上の2行を出すか |
| `quota` | true | 帯にクォータを出すか |
| `status` | false | ステータスラインにも短く出すか |

## 確認済み / 未確認

確認済み (2026-10-05, Claude Code 2.1.289, Manjaro):

- `claude plugin validate` と `claude plugin test` (18件)。テストはモックした時計で、アイドル1時間50分の keep-alive → compact、ユーザーが戻ったときの取り消し、期限切れ時のスキップ、帯とペインの描画 (terminal / desktop) を確認している。
- 実セッションで帯とペインの表示、`/ttl now` で実際に keep-alive してキャッシュを延長できること (read 20.2k / hit 98%)、Linux のスリープ抑止の登録とセッション終了時の解除。

未確認:

- Windows と macOS のスリープ抑止 (実機で `powercfg /requests` / `pmset -g assertions` を見る)
- 実時間で55分・110分待ったときの自動 keep-alive と compact
