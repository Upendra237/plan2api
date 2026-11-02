<?php
// Calls a local plan2api server with PHP's curl extension. Author: Upendra237
//
//   export PLAN2API_KEY=p2a_...      # from: plan2api create my-app
//   php examples/php.php
//
// Optional: PLAN2API_URL (default http://127.0.0.1:8787)

$url = getenv('PLAN2API_URL') ?: 'http://127.0.0.1:8787';
$key = getenv('PLAN2API_KEY');

if (!$key) {
    fwrite(STDERR, "Set PLAN2API_KEY to a key made with: plan2api create <name>\n");
    exit(1);
}

$ch = curl_init("$url/v1/messages");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 150, // a little longer than plan2api's default 120 s timeout
    CURLOPT_HTTPHEADER => [
        'content-type: application/json',
        'x-api-key: ' . $key,
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'model' => 'sonnet',
        'max_tokens' => 256,
        'system' => 'You are a concise assistant.',
        'messages' => [['role' => 'user', 'content' => 'Say hello in one short sentence.']],
    ]),
]);

$body = curl_exec($ch);
if ($body === false) {
    fwrite(STDERR, "Could not reach plan2api. Is `plan2api start` running?\n");
    exit(1);
}
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$data = json_decode($body, true);
if ($status !== 200) {
    fwrite(STDERR, "plan2api returned an error ($status): {$data['error']['message']}\n");
    exit(1);
}

echo $data['content'][0]['text'], "\n";
echo "({$data['usage']['input_tokens']} input / {$data['usage']['output_tokens']} output tokens)\n";
