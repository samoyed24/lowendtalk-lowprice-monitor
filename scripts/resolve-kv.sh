#!/usr/bin/env bash
# 解析 STATE KV namespace 的 id 并写回 wrangler.jsonc。
#
# 用法（在仓库根目录执行）：
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy ./scripts/resolve-kv.sh
#
# 优先级：
#   1. 环境变量 LET_STATE_KV_ID（复用已有 namespace，推荐给「保留旧状态」的场景）
#   2. 账号里已存在同名（title = KV_TITLE，默认 LET_STATE）的 namespace → 复用其 id
#   3. 都没有 → 新建一个，并写回配置
#
# 说明：wrangler kv namespace list 输出 JSON，同名会复用，因此本脚本可重复执行。

set -euo pipefail

KV_TITLE="${KV_TITLE:-LET_STATE}"
CONFIG="${CONFIG:-wrangler.jsonc}"

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
	echo "错误：需要 CLOUDFLARE_ACCOUNT_ID 环境变量。" >&2
	exit 1
fi
# CLOUDFLARE_API_TOKEN 由 wrangler 直接读取；CI 里由 workflow 注入，本地可先用 wrangler login。
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
	echo "提示：未检测到 CLOUDFLARE_API_TOKEN，将使用 wrangler 已登录的凭据。" >&2
fi

if [[ ! -f "$CONFIG" ]]; then
	echo "错误：找不到配置文件 $CONFIG（请在仓库根目录执行）。" >&2
	exit 1
fi

write_id() {
	node scripts/set-kv-id.mjs "$1" "$CONFIG"
}

if [[ -n "${LET_STATE_KV_ID:-}" ]]; then
	echo "使用 LET_STATE_KV_ID 提供的 id：$LET_STATE_KV_ID"
	write_id "$LET_STATE_KV_ID"
	echo "已写入 $CONFIG"
	exit 0
fi

echo "查询账号中的 KV namespace（title=${KV_TITLE}）..."
list_err="$(mktemp)"
if ! existing="$(npx --no-install wrangler kv namespace list 2>"$list_err")"; then
	echo "::error::wrangler kv namespace list 失败，无法确认 KV 是否已存在，已中止（避免重复创建）：" >&2
	head -c 500 "$list_err" >&2
	rm -f "$list_err"
	exit 1
fi
rm -f "$list_err"

found_id="$(printf '%s' "$existing" | KV_TITLE="$KV_TITLE" node -e '
	let input = "";
	process.stdin.on("data", (c) => (input += c));
	process.stdin.on("end", () => {
		let list;
		try { list = JSON.parse(input); } catch { list = []; }
		if (!Array.isArray(list)) list = [];
		const hit = list.find((n) => n && n.title === process.env.KV_TITLE);
		process.stdout.write(hit && hit.id ? String(hit.id) : "");
	});
')"

if [[ -n "$found_id" ]]; then
	echo "复用已存在的 namespace：$found_id"
	write_id "$found_id"
	echo "已写入 $CONFIG"
	exit 0
fi

echo "未找到同名 namespace，创建新的 $KV_TITLE ..."
created="$(npx --no-install wrangler kv namespace create "$KV_TITLE")"
echo "$created"

new_id="$(printf '%s' "$created" | node -e '
	let input = "";
	process.stdin.on("data", (c) => (input += c));
	process.stdin.on("end", () => {
		const m = input.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/i) || input.match(/([0-9a-f]{32})/i);
		process.stdout.write(m ? m[1] : "");
	});
')"

if [[ -z "$new_id" ]]; then
	echo "错误：创建成功但无法从输出解析出 namespace id。" >&2
	echo "$created" >&2
	exit 1
fi

echo "新 namespace id：$new_id"
write_id "$new_id"
echo "已写入 $CONFIG"
