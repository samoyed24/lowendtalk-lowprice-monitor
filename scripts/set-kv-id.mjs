// 把 STATE KV namespace 的 id 写回 wrangler.jsonc（JSONC，保留注释与缩进）。
//
// 用法：
//   node scripts/set-kv-id.mjs <namespace-id> [config-path]
//
// 只改动 kv_namespaces 数组里 binding=STATE 的条目；没有该条目时插入一个。

import { readFileSync, writeFileSync } from "node:fs";

const id = process.argv[2];
const file = process.argv[3] ?? "wrangler.jsonc";

if (!id) {
	console.error("用法：node scripts/set-kv-id.mjs <namespace-id> [config-path]");
	process.exit(1);
}

const text = readFileSync(file, "utf8");
const block = /"kv_namespaces"\s*:\s*\[[\s\S]*?\]/;
const match = text.match(block);
if (!match) {
	console.error(`错误：在 ${file} 里找不到 kv_namespaces 数组`);
	process.exit(1);
}

const entry = `{ "binding": "STATE", "id": "${id}" }`;
const hasState = /\{\s*"binding"\s*:\s*"STATE"[^}]*\}/.test(match[0]);
const patched = hasState
	? match[0].replace(/\{\s*"binding"\s*:\s*"STATE"[^}]*\}/, entry)
	: match[0].replace(/\[\s*/, `[\n\t\t${entry}\n\t`);

writeFileSync(file, text.replace(block, patched));
