// VTuber の名簿を公式サイトから作り直して data/vtuber-roster.json に書く。
// 普段は collect-vtuber.mjs が 1 週間おきに自動で呼ぶので、手で動かすのは名簿をすぐ直したいときだけ。
//   node scripts/sync-roster.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJson, writeJson, log } from "./lib/util.mjs";
import { syncRoster } from "./lib/vtuber-roster.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER = join(ROOT, "data", "vtuber-roster.json");

const config = await readJson(join(ROOT, "config.json"));
const previous = await readJson(ROSTER, null);
const started = Date.now();
const roster = await syncRoster(config, previous);
await writeJson(ROSTER, roster);
const byAgency = Object.fromEntries(roster.report.map((r) => [r.agency, r.count]));
log(`名簿を書き出しました: ${roster.talents.length} 人 / 公式 ${roster.officials.length} チャンネル（${Math.round((Date.now() - started) / 1000)} 秒）`, byAgency);
