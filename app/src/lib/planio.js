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

// ExcelはUTF-8のCSVをそのまま開くと日本語が文字化けする（Shift_JISと解釈するため）。
// 先頭にBOMを付けるとUTF-8と認識して正しく開ける。plan.csvは手編集する前提の
// ファイルなので、書き出し時は必ずBOMを付ける。
const BOM = '﻿';

/** オブジェクト配列をCSVテキストに変換する（columns順・Excel向けにBOM付き）。 */
export function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c])).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

/** CSVテキストをオブジェクト配列にパースする（引用符・エスケープ対応の簡易版）。 */
export function fromCsv(text) {
  const rows = [];
  // BOM付きで保存されたファイル（Excelで上書き保存した場合など）も読めるようにする
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length > 0);
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

/**
 * 日付を 'YYYY-MM-DD' に正規化する。解釈できなければ null。
 * Excelで編集すると書式が変わることがあり、旧ツール(ref/)は M/D/YYYY 形式だったため、
 * 実運用でよく現れる表記をまとめて受け付ける。
 */
export function normalizeDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/); // 2026-07-03 / 2026/7/3
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);     // 7/3/2026（旧ツール形式）
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

/**
 * 時刻を 'HH:mm' に正規化する。解釈できなければ null。
 * 旧ツール(ref/)は HHmm 形式（例 1553、日をまたぐ深夜は 342 や 27）だった。
 * 桁数が足りないものは4桁にゼロ埋めして解釈する（27 → 0027 → 00:27）。
 */
export function normalizeTime(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let m = s.match(/^(\d{1,2}):(\d{2})$/); // 15:53 / 9:05
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h <= 23 && mi <= 59 ? `${pad(h)}:${pad(mi)}` : null;
  }
  m = s.match(/^(\d{1,4})$/); // 1553 / 342 / 27（旧ツール形式）
  if (m) {
    const four = m[1].padStart(4, '0');
    const h = Number(four.slice(0, 2));
    const mi = Number(four.slice(2));
    return h <= 23 && mi <= 59 ? `${four.slice(0, 2)}:${four.slice(2)}` : null;
  }
  return null;
}

/**
 * plan.csv の1行を正規化する。日付・時刻が解釈できない行は null を返す
 * （旧ツールの終了マーカー行 `e,e,e,...` もここで落ちる）。
 */
export function normalizePlanRow(row) {
  const date = normalizeDate(row['日付']);
  const start = normalizeTime(row['開始']);
  const end = normalizeTime(row['終了']);
  if (!date || !start || !end) return null;
  return { ...row, 日付: date, 開始: start, 終了: end };
}

export function writePlanCsv(planPath, rows) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, toCsv(rows, PLAN_COLUMNS), 'utf8');
}

/**
 * plan.csv を読む。日付・時刻は正規化するので、Excelで書式が変わったファイルや
 * 旧ツール(ref/)形式のファイルもそのまま読める。解釈できない行は取り除かれる。
 */
export function readPlanCsv(planPath) {
  return fromCsv(fs.readFileSync(planPath, 'utf8'))
    .map(normalizePlanRow)
    .filter(Boolean);
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
