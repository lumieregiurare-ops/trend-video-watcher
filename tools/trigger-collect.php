<?php
/**
 * GitHub Actions の collect を外から叩くためのスクリプト。
 *
 * GitHub のスケジュール実行（cron）はこのアカウントではほとんど配信されず、
 * 10 分おきに置いても 1 回も走らなかった（2026-09-16 実測）。
 * 一方 workflow_dispatch / repository_dispatch は確実に動くので、
 * ロリポップの cron からこのスクリプトを 30 分おきに実行して起動する。
 *
 * 置き場所と設定
 *   1. このファイルを公開ディレクトリの**外**に置く（例: /home/users/0/xxxx/tools/trigger-collect.php）。
 *      公開ディレクトリに置くと誰でも叩けてしまう。
 *   2. 同じ場所に token.txt を作り、GitHub のトークンだけを 1 行で書く。パーミッションは 600。
 *      トークンは Settings → Developer settings → Fine-grained personal access tokens で作る。
 *      - Repository access: 対象のリポジトリだけを選ぶ
 *      - Permissions: Contents = Read and write（repository_dispatch に必要なのはこれだけ）
 *      - 有効期限を必ず設定し、期限が切れたら作り直す
 *   3. ロリポップのユーザー専用ページ → cron 設定で 30 分おきに実行する。
 *      コマンド例: /usr/local/bin/php /home/users/0/xxxx/tools/trigger-collect.php
 *
 * リポジトリを増やすときは REPOS に足す。
 */

declare(strict_types=1);

const REPOS = [
    'lumieregiurare-ops/trend-video-watcher',
    'lumieregiurare-ops/aimatome',
    'lumieregiurare-ops/mhmatome',
    'lumieregiurare-ops/pokematome',
    'lumieregiurare-ops/animematome',
];
const EVENT_TYPE = 'collect';
const TOKEN_FILE = __DIR__ . '/token.txt';

// ロリポップの cron は PHP を CLI ではなく CGI 的に実行することがあり、
// その場合 STDERR 定数が未定義で Fatal error になる。php://stderr を直接開けば両対応できる。
$stderr = fopen('php://stderr', 'w');

$token = @file_get_contents(TOKEN_FILE);
if ($token === false || trim($token) === '') {
    fwrite($stderr, "token.txt が読めません: " . TOKEN_FILE . "\n");
    exit(1);
}
$token = trim($token);

$failed = 0;
foreach (REPOS as $repo) {
    $ch = curl_init("https://api.github.com/repos/{$repo}/dispatches");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_POSTFIELDS => json_encode(['event_type' => EVENT_TYPE]),
        CURLOPT_HTTPHEADER => [
            'Accept: application/vnd.github+json',
            'X-GitHub-Api-Version: 2022-11-28',
            'Authorization: Bearer ' . $token,
            'Content-Type: application/json',
            // GitHub API は User-Agent が無いと 403 を返す
            'User-Agent: trigger-collect',
        ],
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    // 成功は 204 No Content
    if ($status === 204) {
        echo date('c') . " {$repo}: ok\n";
        continue;
    }
    $failed++;
    fwrite($stderr, date('c') . " {$repo}: NG status={$status} err={$err} body={$body}\n");
}

exit($failed > 0 ? 1 : 0);
