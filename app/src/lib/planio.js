// ファイル入出力層。純粋ロジック(aggregate/planner/…)とファイルシステムの橋渡し。
// データはすべてプレーンCSV/JSON（Excel・フロンティアAIで直接編集できる形）。

import fs from 'node:fs';
import path from 'node:path';
import { parseHeartbeatCsv } from './aggregate.js';

/** config.json を読む。無ければ config.example.json、それも無ければ {}。 */
export function loadConfig(repoRoot) {
  for (const name of ['config.json', 'config.example.json']) {
    const p = path.join(repoRoot, name);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        throw new Error(`${name} の解析に失敗しました: ${e.message}`);
      }
    }
  }
  return {};
}

/** 'YYYY-MM' の1つ前・当月・1つ後の月キーを返す（5時区切りで月境界の日が隣月ファイルに入るため）。 */
export function adjacentMonths(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const prev = new Date(y, m - 2, 1);
  const next = new Date(y, m, 1);
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return [key(prev), monthKey, key(next)];
}

/**
 * 指定月(YYYY-MM)に関係するheartbeatレコードを読み込む。
 * 当月と前後1ヶ月のCSVを読み、パースして時刻順にマージする。
 */
export function loadHeartbeatRecords(heartbeatDir, monthKey) {
  const all = [];
  for (const mk of adjacentMonths(monthKey)) {
    const p = path.join(heartbeatDir, `${mk}.csv`);
    if (fs.existsSync(p)) {
      all.push(...parseHeartbeatCsv(fs.readFileSync(p, 'utf8')));
    }
  }
  const byKey = new Map();
  for (const r of all) byKey.set(r.ts.getTime(), r);
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
}

/** CSVの1フィールドを必要に応じて引用符で囲む。 */
function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** オブジェクト配列をCSVテキストに変換する（columns順）。 */
export function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/** CSVテキストをオブジェクト配列にパースする（引用符・エスケープ対応の簡易版）。 */
export function fromCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return rows;
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const obj = {};
    header.forEach((h, idx) => { obj[h.trim()] = (cells[idx] ?? '').trim(); });
    rows.push(obj);
  }
  return rows;
}

export const PLAN_COLUMNS = ['日付', '曜日', '分類', '開始', '終了', '終了理由', 'メモ'];

export function writePlanCsv(planPath, rows) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, toCsv(rows, PLAN_COLUMNS), 'utf8');
}

export function readPlanCsv(planPath) {
  return fromCsv(fs.readFileSync(planPath, 'utf8'));
}

export function writePreviewHtml(previewPath, html) {
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(previewPath, html, 'utf8');
}

/**
 * pto.csv を読み、Map<'YYYY-MM-DD', {type, pcTime:'exclude'|'include'}> を返す。
 * 列: 日付, 種別, PC稼働（"除外"/"計上"、または exclude/include）。無ければ空Map。
 */
export function loadPto(ptoPath) {
  const map = new Map();
  if (!fs.existsSync(ptoPath)) return map;
  for (const row of fromCsv(fs.readFileSync(ptoPath, 'utf8'))) {
    const date = (row['日付'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const raw = (row['PC稼働'] || '').trim();
    const pcTime = (raw === '計上' || raw.toLowerCase() === 'include') ? 'include' : 'exclude';
    map.set(date, { type: (row['種別'] || '').trim() || 'PTO', pcTime });
  }
  return map;
}
