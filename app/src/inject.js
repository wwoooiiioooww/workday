#!/usr/bin/env node
// Injector: plan.csv の内容を Workday の勤怠画面に自動入力する。
//
// 使い方:
//   node src/inject.js 2026-07              入力を実行（日ごとに確認しながら）
//   node src/inject.js 2026-07 --dry-run    OKを押さずに入力欄まで動かして確認だけする
//   node src/inject.js 2026-07 --yes        日ごとの確認を省略して一気に進める
//   node src/inject.js 2026-07 --assist     日付セルのクリックだけ人間が行う（保険）
//
// 安全上の原則:
//   - 提出（レビュー）ボタンは絶対に押さない。人間が押す
//   - 入力前に「この内容で入れます」の確認ゲートを必ず通す
//   - 入力後に画面から実績を読み戻し、plan と一致するか検証する
//   - 中断→再開しても入力済みの日は二重入力しない（result.csv で管理）

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig, readPlanCsv, fromCsv, toCsv } from './lib/planio.js';
import {
  RESULT_COLUMNS, groupPlanByDate, pendingByDate, checkDayBlocks,
  formatConfirmation, makeResultRow, dayCellId, dayIndexInWeek,
  parseWeekRange, weekDirection, hasAfterMidnightBlock,
} from './lib/injectlib.js';
import { SELECTORS, toWorkdayTime, parseEventSubtitle, parseHoursEntered } from './lib/workday-selectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const profileDir = path.join(repoRoot, 'app', 'playwright-profile');

const MAX_WEEK_NAV = 60; // 週送りの上限（無限ループ防止）

// 対話入力は1つのインターフェースを使い回す。
// 質問のたびに作り直すと、入力をパイプで流したときに取りこぼして固まることがある。
let rl = null;
function ask(question) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}
function closeAsk() {
  if (rl) { rl.close(); rl = null; }
}

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }

function resolveDir(p, fallback) {
  const v = p || fallback;
  return path.isAbsolute(v) ? v : path.join(repoRoot, v);
}

/** result.csv を読む（無ければ空）。 */
function readResults(resultPath) {
  if (!fs.existsSync(resultPath)) return [];
  return fromCsv(fs.readFileSync(resultPath, 'utf8'));
}

/** result.csv に1行追記する（毎回書き出すので中断しても記録が残る）。 */
function appendResult(resultPath, rows, row) {
  rows.push(row);
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, toCsv(rows, RESULT_COLUMNS), 'utf8');
}

/**
 * 失敗時にポップアップ周辺のDOMをダンプする。
 * 実機を見られない開発者(AI)が原因を特定できるようにするための保険。
 */
async function dumpDom(page, label) {
  const dumpPath = path.join(repoRoot, 'data', 'probe', `inject-dump-${Date.now()}.txt`);
  try {
    const info = await page.evaluate(() => {
      const trim = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return [...document.querySelectorAll('[data-automation-id],input,button,[role="button"],[role="link"]')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          return `<${el.tagName.toLowerCase()}> aid="${el.getAttribute('data-automation-id') || ''}" role="${el.getAttribute('role') || ''}" aria="${trim(el.getAttribute('aria-label'))}" text="${trim(el.innerText || el.textContent)}" @(${Math.round(r.x)},${Math.round(r.y)})`;
        })
        .filter(Boolean)
        .slice(0, 300)
        .join('\n');
    });
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    fs.writeFileSync(dumpPath, `${label}\n${new Date().toISOString()}\n\n${info}`, 'utf8');
    console.log(`   🔎 画面の状態を保存しました（開発者に共有してください）: ${dumpPath}`);
  } catch {
    // ダンプ失敗で本処理を止めない
  }
}

/** 週ラベルの生テキストを読む。 */
async function readWeekLabelText(page) {
  const el = page.locator(SELECTORS.weekRangeLabel).first();
  await el.waitFor({ state: 'visible', timeout: 30000 });
  return (await el.innerText()).trim();
}

/** 表示中の週の範囲を読む。 */
async function readWeekRange(page) {
  return parseWeekRange(await readWeekLabelText(page));
}

/**
 * 週ラベルが prevText から変わるまで待つ。変わったら true。
 * Workday はカレンダーの再描画に時間がかかることがあるため、
 * 「変わっていない＝移動失敗」と即断せず、ここで十分に待つ。
 */
async function waitForWeekLabelChange(page, prevText, timeout) {
  try {
    await page.waitForFunction(
      ({ sel, prev }) => {
        const e = document.querySelector(sel);
        const t = e && (e.innerText || '').trim();
        return !!t && t !== prev;
      },
      { sel: SELECTORS.weekRangeLabel, prev: prevText },
      { timeout },
    );
    await page.waitForTimeout(500); // 描画の落ち着き待ち
    return true;
  } catch {
    return false;
  }
}

/** 目的の日付が含まれる週まで、前へ/次へを押して移動する。 */
async function navigateToWeek(page, targetDate) {
  for (let i = 0; i < MAX_WEEK_NAV; i++) {
    const label = await readWeekLabelText(page);
    const range = parseWeekRange(label);
    if (!range) throw new Error(`週の表示（例: 2026年6月29日～7月5日）を読み取れませんでした（実際の表示: "${label}"）。勤怠の週表示が開いているか確認してください。`);
    const dir = weekDirection(targetDate, range);
    if (dir === 0) return range;

    const btn = dir < 0 ? SELECTORS.prevWeekButton : SELECTORS.nextWeekButton;
    // 1回目のクリックで反応がなければ、もう一度だけ押して待ち直す
    // （2026-07-25 実機では待ち時間不足で「移動できない」と誤判定していた）
    let moved = false;
    for (let attempt = 0; attempt < 2 && !moved; attempt++) {
      await page.locator(btn).first().click();
      moved = await waitForWeekLabelChange(page, label, 20000);
    }
    if (!moved) {
      throw new Error(`週の移動ができませんでした（${range.start}〜${range.end} のまま。ボタンを2回押しても表示が変わりませんでした）。`);
    }
  }
  throw new Error(`${MAX_WEEK_NAV}回移動しても目的の週（${targetDate}）に到達できませんでした。`);
}

/** 開いているポップアップを閉じる（キャンセル→閉じる→Escape の順に試す）。 */
async function closePopup(page) {
  const startInput = page.getByRole('textbox', { name: '開始' }).first();
  for (const sel of [SELECTORS.cancelButton, SELECTORS.closeButton]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      if (await startInput.isHidden().catch(() => false)) return true;
      await startInput.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      if (await startInput.isHidden().catch(() => true)) return true;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await startInput.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  return await startInput.isHidden().catch(() => true);
}

/** その日の入力ポップアップを開く。 */
async function openEntryPopup(page, date, assist) {
  if (assist) {
    await ask(`   👉 ${date} の「時間を入力」ポップアップを手動で開いて、Enterを押してください: `);
    return;
  }
  const cellSel = SELECTORS.dayCell(dayCellId(date));
  const cell = page.locator(cellSel).first();
  await cell.waitFor({ state: 'visible', timeout: 20000 });
  const cellBox = await cell.boundingBox();
  const body = page.locator(SELECTORS.weeklyBody).first();
  const bodyBox = await body.boundingBox();
  if (!cellBox || !bodyBox) throw new Error(`${date} の日付セル（${cellSel}）の位置を取得できませんでした。`);

  // 日付セルの列に合わせた x で、時間グリッドの中ほどをクリックすると
  // 「時間を入力」リンクが現れる（実機DOM調査で確認した挙動）
  const x = cellBox.x + cellBox.width / 2;
  const y = bodyBox.y + bodyBox.height * 0.55;
  await page.mouse.click(x, y);

  const enter = page.locator(SELECTORS.enterTimeLink).first();
  try {
    await enter.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    // クリック位置に既存の予定があると出ないことがあるので、少し上でも試す
    await page.mouse.click(x, bodyBox.y + bodyBox.height * 0.25);
    await enter.waitFor({ state: 'visible', timeout: 8000 });
  }
  await enter.click();
  // ポップアップの「開始」入力欄が出るまで待つ
  await page.getByRole('textbox', { name: '開始' }).first().waitFor({ state: 'visible', timeout: 20000 });
}

/** 終了理由を選ぶ（既定は「終了」なので、「休憩」のときだけ変更する）。 */
async function setEndReason(page, reason) {
  if (reason === '終了') return true; // 既定値のまま
  const widgets = page.locator(SELECTORS.endReasonWidget);
  const count = await widgets.count();
  for (let i = 0; i < count; i++) {
    const w = widgets.nth(i);
    if (!(await w.isVisible().catch(() => false))) continue;
    await w.click();
    const opt = page.locator(SELECTORS.promptOption).filter({ hasText: reason }).first();
    try {
      await opt.waitFor({ state: 'visible', timeout: 5000 });
      await opt.click();
      await page.waitForTimeout(300);
      return true;
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  return false;
}

/** ポップアップに1ブロック分を入力してOKを押す。 */
async function fillBlock(page, block, { dryRun }) {
  const start = toWorkdayTime(block['開始']);
  const end = toWorkdayTime(block['終了']);
  const reason = (block['終了理由'] || '').trim();

  const startInput = page.getByRole('textbox', { name: '開始' }).first();
  const endInput = page.getByRole('textbox', { name: '終了' }).first();
  await startInput.waitFor({ state: 'visible', timeout: 20000 });

  await startInput.click();
  await startInput.fill('');
  await startInput.fill(start);
  await page.waitForTimeout(200);

  await endInput.click();
  await endInput.fill('');
  await endInput.fill(end);
  await page.waitForTimeout(200);

  const reasonOk = await setEndReason(page, reason);
  if (!reasonOk) {
    await dumpDom(page, `終了理由「${reason}」の選択に失敗`);
    throw new Error(`終了理由「${reason}」を選べませんでした。`);
  }

  if (dryRun) {
    console.log(`   🧪 [dry-run] ${block['開始']}-${block['終了']} (${reason}) を入力しました（OKは押しません）`);
    await ask('   ブラウザで内容を確認したら Enter を押してください（ポップアップは自動で閉じます）: ');
    const closed = await closePopup(page);
    if (!closed) {
      console.log('   ⚠ ポップアップを自動で閉じられませんでした。手動で閉じてから次に進んでください。');
      await ask('   閉じたら Enter: ');
    }
    return;
  }

  const ok = page.locator(SELECTORS.okButton).filter({ hasText: /^OK$/ }).first();
  await ok.waitFor({ state: 'visible', timeout: 10000 });
  await ok.click();
  // ポップアップが閉じる（=開始欄が消える）のを待つ
  await page.getByRole('textbox', { name: '開始' }).first()
    .waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

/** その日の入力結果を画面から読み戻す。 */
async function readBackDay(page, date) {
  const idx = dayIndexInWeek(date);
  const result = { hours: null, events: [] };
  try {
    const el = page.locator(SELECTORS.hoursEntered(idx)).first();
    if (await el.isVisible().catch(() => false)) {
      result.hours = parseHoursEntered(await el.innerText());
    }
  } catch { /* 読めなければ null のまま */ }

  // その日の列にある予定ブロックの時刻を拾う
  try {
    const cellBox = await page.locator(SELECTORS.dayCell(dayCellId(date))).first().boundingBox();
    if (cellBox) {
      const events = page.locator(SELECTORS.calendarEvent);
      const n = await events.count();
      for (let i = 0; i < n; i++) {
        const ev = events.nth(i);
        const box = await ev.boundingBox().catch(() => null);
        if (!box) continue;
        const sameColumn = Math.abs((box.x + box.width / 2) - (cellBox.x + cellBox.width / 2)) < cellBox.width / 2;
        if (!sameColumn) continue;
        const sub = await ev.locator(SELECTORS.eventSubtitle).first().innerText().catch(() => '');
        const parsed = parseEventSubtitle(sub);
        if (parsed) result.events.push(parsed);
      }
    }
  } catch { /* 読めなければ空のまま */ }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const monthKey = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  if (!monthKey) fail('対象年月を YYYY-MM 形式で指定してください（例: node src/inject.js 2026-07）。');
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const dryRun = flags.has('--dry-run');
  const autoYes = flags.has('--yes');
  const assist = flags.has('--assist');

  const config = loadConfig(repoRoot);
  const planDir = resolveDir(config?.planner?.planDir, 'data/plan');
  const planPath = path.join(planDir, `${monthKey}.plan.csv`);
  const resultPath = path.join(resolveDir(config?.injector?.resultDir, 'data/result'), `${monthKey}.result.csv`);
  const homeUrl = config?.workday?.initialUrl || 'https://wd5.myworkday.com/cisco/d/home.htmld';

  if (!fs.existsSync(planPath)) fail(`plan.csv が見つかりません: ${planPath}\n   先に  node src/plan.js ${monthKey}  を実行してください。`);

  const planRows = readPlanCsv(planPath);
  const planByDate = groupPlanByDate(planRows);
  if (planByDate.size === 0) fail('plan.csv に入力対象の行がありません。');

  // 休憩/終了の並びが Workday の運用（途中=休憩・最終=終了）に合っているか確認
  const problems = [];
  for (const [date, blocks] of planByDate) problems.push(...checkDayBlocks(date, blocks));
  if (problems.length) {
    console.log('❌ plan.csv に修正が必要な点があります:');
    problems.forEach((p) => console.log(`   ${p}`));
    fail('plan.csv を修正してから再実行してください。');
  }

  const resultRows = readResults(resultPath);
  const pending = pendingByDate(planByDate, resultRows);
  if (pending.size === 0) {
    console.log('✅ すべて入力済みです（result.csv より）。作業はありません。');
    return;
  }

  // ---- 確認ゲート ----
  console.log('==========================================================');
  console.log(`Workday 自動入力  ${monthKey}${dryRun ? '  [dry-run: OKを押しません]' : ''}`);
  console.log('==========================================================');
  if (resultRows.length > 0) console.log(`（入力済みの分はスキップします: ${resultPath}）\n`);
  console.log('これから以下の内容を入力します:\n');
  console.log(formatConfirmation(pending));

  // 深夜帯（AM5時より前）のブロックを含む日は、Workday上のどの日に入れるべきか
  // 解釈が分かれるため、必ず本人の目で確認してもらう
  const midnightDates = [...pending.entries()].filter(([, b]) => hasAfterMidnightBlock(b)).map(([d]) => d);
  if (midnightDates.length) {
    console.log('\n⚠ 深夜（午前0時台）にまたがる勤務の日があります:');
    midnightDates.forEach((d) => console.log(`   ${d}`));
    console.log('   これらは「その勤務日の欄」に深夜の時刻として入力します（現行版と同じ扱い）。');
    console.log('   Workday上の表示が意図と違う場合は、入力後に画面で調整してください。');
  }

  console.log('\n※ 提出（レビュー）ボタンは押しません。最後にご自身で確認して提出してください。');
  const answer = await ask('\nこの内容で入力を開始しますか？ [y/N]: ');
  if (answer.toLowerCase() !== 'y') {
    console.log('中止しました。plan.csv を編集する場合は  node src/plan.js ' + monthKey + ' --refresh  で再確認できます。');
    return;
  }

  // ---- ブラウザ起動 ----
  // 既定はシステムのChrome。環境変数で差し替えられるようにしておく
  //   WORKDAY_BROWSER_EXECUTABLE: Chromeの実行ファイルを直接指定（見つからない環境の保険）
  //   WORKDAY_HEADLESS=1: 画面を出さずに動かす（自動テスト用）
  fs.mkdirSync(profileDir, { recursive: true });
  const launchOptions = { headless: process.env.WORKDAY_HEADLESS === '1', viewport: null };
  if (process.env.WORKDAY_BROWSER_EXECUTABLE) {
    launchOptions.executablePath = process.env.WORKDAY_BROWSER_EXECUTABLE;
  } else {
    launchOptions.channel = 'chrome';
  }
  const context = await chromium.launchPersistentContext(profileDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(homeUrl);
    console.log('\nブラウザを開きました。');
    console.log('ログイン（Duo認証含む）を済ませ、勤怠の「週表示」（日付が横に並ぶ画面）を開いてください。');
    await ask('準備ができたら Enter を押してください: ');

    // 週表示が開けているか確認
    const range = await readWeekRange(page).catch(() => null);
    if (!range) {
      await dumpDom(page, '週表示の判定に失敗');
      fail('勤怠の週表示を認識できませんでした。週表示になっているか確認して、もう一度実行してください。');
    }
    console.log(`表示中の週: ${range.start} 〜 ${range.end}`);

    let okCount = 0;
    let failCount = 0;

    for (const [date, blocks] of pending) {
      console.log(`\n──────────── ${date} (${blocks.length}ブロック) ────────────`);
      for (const b of blocks) {
        console.log(`  ${b['開始']}-${b['終了']} (${b['終了理由']})`);
      }
      if (!autoYes && !dryRun) {
        const a = await ask('  この日を入力しますか？ [y]es / [s]kip / [q]uit: ');
        if (a.toLowerCase() === 's') {
          for (const b of blocks) appendResult(resultPath, resultRows, makeResultRow(b, 'skipped', 'ユーザー指示によりスキップ'));
          continue;
        }
        if (a.toLowerCase() === 'q') { console.log('  中断しました。'); break; }
      }

      try {
        await navigateToWeek(page, date);
      } catch (e) {
        console.log(`  ❌ 週の移動に失敗: ${e.message}`);
        await dumpDom(page, `週移動に失敗 (${date})`);
        for (const b of blocks) appendResult(resultPath, resultRows, makeResultRow(b, 'failed', `週移動に失敗: ${e.message}`));
        failCount += blocks.length;
        continue;
      }

      let dayAborted = false;
      for (let i = 0; i < blocks.length && !dayAborted; i++) {
        const b = blocks[i];
        let done = false;
        while (!done) {
          try {
            console.log(`  ▶ ${b['開始']}-${b['終了']} (${b['終了理由']}) を入力中...`);
            await openEntryPopup(page, date, assist);
            await fillBlock(page, b, { dryRun });
            appendResult(resultPath, resultRows, makeResultRow(b, dryRun ? 'skipped' : 'ok', dryRun ? 'dry-run' : ''));
            if (!dryRun) okCount++;
            console.log('    ✅ 入力しました');
            done = true;
          } catch (e) {
            console.log(`    ❌ 失敗: ${e.message}`);
            await dumpDom(page, `ブロック入力に失敗 (${date} ${b['開始']}-${b['終了']})`);
            const a = await ask('    [r]etry 再試行 / [m]anual 手動で入力した / [s]kip このブロックを飛ばす / [q]uit 中断: ');
            const c = a.toLowerCase();
            if (c === 'r') continue;
            if (c === 'm') {
              appendResult(resultPath, resultRows, makeResultRow(b, 'manual', '手動入力'));
              done = true;
            } else if (c === 's') {
              appendResult(resultPath, resultRows, makeResultRow(b, 'failed', e.message));
              failCount++;
              done = true;
            } else {
              appendResult(resultPath, resultRows, makeResultRow(b, 'failed', e.message));
              failCount++;
              dayAborted = true;
              done = true;
              console.log('  中断しました。');
            }
          }
        }
      }
      if (dayAborted) break;

      // ---- 読み戻し検証 ----
      if (!dryRun) {
        const back = await readBackDay(page, date);
        const expectedMin = blocks.reduce((s, b) => {
          const t = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
          let d = t(b['終了']) - t(b['開始']);
          if (d < 0) d += 24 * 60;
          return s + d;
        }, 0);
        if (back.hours == null) {
          console.log('  ⚠ 画面から合計時間を読み取れませんでした（入力自体は完了しています）。目視で確認してください。');
        } else {
          const expectedHours = expectedMin / 60;
          // 既存の入力がある日もあるため、「plan分以上入っているか」で確認する
          const diff = back.hours - expectedHours;
          if (Math.abs(diff) < 0.02) {
            console.log(`  ✅ 読み戻し確認: 画面の合計 ${back.hours} 時間（planと一致）`);
          } else if (diff > 0) {
            console.log(`  ℹ 画面の合計 ${back.hours} 時間（今回入力分 ${expectedHours.toFixed(2)} 時間 + 既存分 ${diff.toFixed(2)} 時間と思われます）`);
          } else {
            console.log(`  ⚠ 画面の合計 ${back.hours} 時間が、入力したはずの ${expectedHours.toFixed(2)} 時間より少ないです。画面で確認してください。`);
          }
        }
        if (back.events.length) {
          console.log(`     画面上の予定: ${back.events.map((e) => `${e.start}-${e.end}${e.reason ? `(${e.reason})` : ''}`).join(' / ')}`);
        }
      }
    }

    console.log('\n==========================================================');
    console.log(`完了: 成功 ${okCount}ブロック / 失敗 ${failCount}ブロック`);
    console.log(`記録: ${resultPath}`);
    console.log('👉 画面の内容をご自身で確認し、問題なければ「レビュー」から提出してください（自動では押しません）。');
    console.log('==========================================================');
    await ask('\nEnter を押すとブラウザを閉じます: ');
  } finally {
    await context.close().catch(() => {});
    closeAsk();
  }
}

main().then(() => closeAsk()).catch((e) => {
  console.error(`\n❌ エラー: ${e.message}`);
  closeAsk();
  process.exit(1);
});
