// ==UserScript==
// @name         FTTx-бот: обновление сайта из Qlik
// @namespace    https://dinarazaiko.github.io/fttx-dashboard/
// @version      1.2
// @description  Обновляет data.json сайта «Новые установки FTTx» после перезагрузки Qlik WFM и по кнопке «🔄 Обновить сейчас» в Telegram
// @match        https://qtest/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.telegram.org
// @connect      api.github.com
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/dinarazaiko/fttx-dashboard/main/fttx-bot.user.js
// @downloadURL  https://raw.githubusercontent.com/dinarazaiko/fttx-dashboard/main/fttx-bot.user.js
// ==/UserScript==

/*
 Как это работает (держите в Chrome открытой любую вкладку https://qtest/…):
  • раз в 5 минут смотрит время перезагрузки WFM; если оно новее данных на сайте — собирает данные
    и кладёт data.json в GitHub (с 8:00 до 22:59);
  • слушает Telegram (команды — для администраторов из настроек и одобренных подписчиков):
      /start   — новый участник просит доступ; администратор одобряет кнопкой, после этого
                 участник получает все сводки и может пользоваться командами;
      /svodka  — прислать сводку по последним данным только себе (≈1 минута);
      /update  или кнопка «🔄 Обновить из Qlik» — забрать свежие данные из Qlik и прислать сводку себе;
      /stop    — отписаться;  /help — список команд;
  • коммит data.json запускает GitHub Action «FTTx — сводка в Telegram»: обычное обновление уходит
    всем (TELEGRAM_CHAT_ID + subscribers.json), а запросы — только тому, кто спросил (поле sendTo).
 Работает в одной вкладке: если открыто несколько вкладок Qlik, остальные ждут.
 Настройки: значок Tampermonkey → «FTTx-бот: настройки».
*/
(function () {
  'use strict';
  const REPO = 'dinarazaiko/fttx-dashboard';
  const WFM = '49bbf2a0-a537-400e-8e47-2d311df1f1e9';
  const SALES = 'e1e154eb-0977-4e66-8526-ad52a159a455';
  const BOOKMARK = 'c91dbe08-d09b-42d4-b5a9-d2e49f32902c';   // «устгпон1», кнопка «Установка GPON»
  const PIVOT = 'dd53892d-c27a-49a7-b1f5-b2939e8d278e';      // «Заказы в разрезе регионов»
  const REMAP = { 'Абайская область': 'Семипалатинск', 'Жетысуская область': 'Алматинская ОДТ', 'Улытауская область': 'Карагандинская ОДТ' };
  const AUTO_FROM = 8, AUTO_TO = 22;                         // авто-обновления с 8:00 до 22:59 по времени ноутбука
  const WFM_CHECK_MS = 5 * 60 * 1000;
  const TAB = (() => { try { let v = sessionStorage.getItem('fttxBotTab'); if (!v) { v = Math.random().toString(36).slice(2); sessionStorage.setItem('fttxBotTab', v); } return v; } catch (e) { return Math.random().toString(36).slice(2); } })();
  const QLIK_LOST = 'нет соединения с Qlik';

  // ---------- настройки ----------
  const cfg = () => ({ gh: GM_getValue('ghToken', ''), tg: GM_getValue('tgToken', ''), chats: GM_getValue('chatIds', '') });
  GM_registerMenuCommand('FTTx-бот: настройки', () => {
    const gh = prompt('Токен GitHub (fine-grained, доступ Contents: Read and write к репозиторию fttx-dashboard).\nОставьте пустым, чтобы не менять.', '');
    if (gh) GM_setValue('ghToken', gh.trim());
    const tg = prompt('Токен Telegram-бота (как в секрете TELEGRAM_BOT_TOKEN). Пусто — не менять.', '');
    if (tg) GM_setValue('tgToken', tg.trim());
    const ch = prompt('ID чатов администратора через запятую (как в секрете TELEGRAM_CHAT_ID). Первый получает запросы на доступ:', GM_getValue('chatIds', ''));
    if (ch !== null) GM_setValue('chatIds', ch.trim());
    log('Настройки сохранены');
  });
  GM_registerMenuCommand('FTTx-бот: обновить сейчас (всем)', () => runUpdate({ forced: 'вручную из браузера' }));

  // ---------- значок состояния ----------
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#0b0b0b;color:#fff;font:12px/1.35 system-ui,sans-serif;padding:7px 10px;border-radius:8px;opacity:.85;max-width:340px;cursor:pointer';
  badge.title = 'FTTx-бот. Нажмите, чтобы скрыть/показать журнал';
  const logBox = document.createElement('div'); logBox.style.cssText = 'display:none;margin-top:6px;max-height:200px;overflow:auto;white-space:pre-wrap;opacity:.85';
  const head = document.createElement('div'); badge.append(head, logBox);
  badge.onclick = () => { logBox.style.display = logBox.style.display === 'none' ? 'block' : 'none'; };
  const hm = () => new Date().toTimeString().slice(0, 5);
  function setHead(t) { head.textContent = 'FTTx-бот · ' + t; }
  function log(t) { const l = `${hm()} ${t}`; console.log('[FTTx-бот]', l); logBox.textContent = (l + '\n' + logBox.textContent).slice(0, 6000); setHead(t); }
  const mount = () => document.body && !badge.isConnected && document.body.appendChild(badge);
  mount(); setInterval(mount, 5000);

  // ---------- одна активная вкладка ----------
  function isLeader() {
    const l = GM_getValue('leader', null), now = Date.now();
    if (!l || l.tab === TAB || now - l.ts > 90000) { GM_setValue('leader', { tab: TAB, ts: now }); return true; }
    return false;
  }

  // ---------- HTTP через Tampermonkey (обходит CSP страницы Qlik) ----------
  function http(method, url, { headers = {}, body = null, timeout = 60000 } = {}) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method, url, headers, data: body, timeout,
      onload: r => res({ status: r.status, text: r.responseText }),
      onerror: () => rej(new Error('сеть: ' + url.split('/')[2])),
      ontimeout: () => rej(new Error('таймаут: ' + url.split('/')[2]))
    }));
  }
  async function tg(method, fields, timeout) {
    const r = await http('POST', `https://api.telegram.org/bot${cfg().tg}/${method}`,
      { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields), timeout: timeout || 60000 });
    const j = JSON.parse(r.text || '{}');
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
    return j.result;
  }
  async function gh(method, path, body) {
    const r = await http(method, `https://api.github.com/repos/${REPO}/${path}`, {
      headers: { Authorization: `Bearer ${cfg().gh}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null });
    if (r.status >= 300) throw new Error(`GitHub ${r.status}: ${(r.text || '').slice(0, 160)}`);
    return JSON.parse(r.text);
  }
  const b64 = s => { const u = new TextEncoder().encode(s); let b = ''; u.forEach(x => b += String.fromCharCode(x)); return btoa(b); };
  const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

  // ---------- движок Qlik по WebSocket ----------
  async function qx(appId) {
    const WS = (typeof unsafeWindow !== 'undefined' && unsafeWindow.WebSocket) || WebSocket;
    const ws = new WS(`wss://${location.host}/app/${appId}?reloadUri=x`);
    let id = 0; const pend = {};
    ws.onmessage = e => { const j = JSON.parse(e.data); if (j.id && pend[j.id]) { j.error ? pend[j.id].rej(new Error(j.error.message || 'Qlik')) : pend[j.id].res(j.result); delete pend[j.id]; } };
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(QLIK_LOST)); setTimeout(() => j(new Error(QLIK_LOST + ' (таймаут)')), 30000); });
    const call = (h, m, p) => new Promise((res, rej) => { const i = ++id; pend[i] = { res, rej }; ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, handle: h, method: m, params: p })); setTimeout(() => { if (pend[i]) { delete pend[i]; rej(new Error('Qlik: таймаут ' + m)); } }, 120000); });
    const doc = (await call(-1, 'OpenDoc', [appId])).qReturn.qHandle;
    const ev = async ex => (await call(doc, 'Evaluate', [ex])).qReturn;
    const cube = async def => {
      const o = (await call(doc, 'CreateSessionObject', [{ qInfo: { qType: 'x' }, qHyperCubeDef: def }])).qReturn.qHandle;
      const lay = (await call(o, 'GetLayout', [])).qLayout.qHyperCube;
      const rows = []; const W = lay.qSize.qcx, H = lay.qSize.qcy, step = Math.floor(10000 / W);
      for (let top = 0; top < H; top += step) {
        const pg = (await call(o, 'GetHyperCubeData', ['/qHyperCubeDef', [{ qTop: top, qLeft: 0, qWidth: W, qHeight: Math.min(step, H - top) }]])).qDataPages[0];
        pg.qMatrix.forEach(r => rows.push(r));
      }
      return rows;
    };
    return { ws, call, doc, ev, cube, close: () => ws.close() };
  }
  const ts = s => (s || '').slice(0, 16).replace(' ', 'T');
  async function wfmReloadTime() { const W = await qx(WFM); try { return ts(await W.ev("Timestamp(ReloadTime(),'YYYY-MM-DD hh:mm')")); } finally { W.close(); } }

  // ---------- сборка data.json (как extract_qlik.js + parse_qlik.py) ----------
  async function buildData(forced, sendTo) {
    const odt = n => REMAP[n] || n, ymd = d => d.toISOString().slice(0, 10);
    const W = await qx(WFM);
    let wf, asOf, lastEvent, createdAsOf, today;
    try {
      await W.call(W.doc, 'ApplyBookmark', [BOOKMARK]);
      const pv = (await W.call(W.doc, 'GetObject', [PIVOT])).qReturn.qHandle;
      const P = (await W.call(pv, 'GetProperties', [])).qProp.qHyperCubeDef;
      today = await W.ev("Date(Today(),'YYYY-MM-DD')");
      const T = new Date(today + 'T00:00:00Z'), d1 = new Date(T); d1.setUTCDate(d1.getUTCDate() - 1);
      const done = d => `Count({$<state_name=, state_name={'Выполнено'}, last_state_ts={"${d}*"}>} DISTINCT siebel_order_id)`;
      const A = await W.cube({
        qDimensions: [{ qDef: { qFieldDefs: P.qDimensions[0].qDef.qFieldDefs } }, { qDef: { qFieldDefs: P.qDimensions[1].qDef.qFieldDefs } }],
        qMeasures: [{ qDef: { qDef: P.qMeasures[0].qDef.qDef } }, { qDef: { qDef: P.qMeasures[1].qDef.qDef } },
          { qDef: { qDef: "Count({$<state_name=>} DISTINCT If(Floor(wfm_create_ts)=Floor(Today()), siebel_order_id))" } },
          { qDef: { qDef: done(today) } }, { qDef: { qDef: done(ymd(d1)) } }] });
      asOf = ts(await W.ev("Timestamp(ReloadTime(),'YYYY-MM-DD hh:mm')"));
      lastEvent = ts(await W.ev("MaxString({$<state_name=, state_name={'Выполнено'}>} last_state_ts)"));
      createdAsOf = ts(await W.ev("Timestamp({$<state_name=>} Max(wfm_create_ts),'YYYY-MM-DD hh:mm')"));
      wf = A.filter(r => r[1].qText !== '-' && r[0].qText !== '-').map(r => ({
        rdt: r[0].qText, fil: r[1].qText, total: r[2].qNum, clean: r[3].qNum, createdToday: r[4].qNum, doneToday: r[5].qNum, doneYesterday: r[6].qNum }));
    } finally { W.close(); }
    const T = new Date(today + 'T00:00:00Z');
    const d1 = new Date(T); d1.setUTCDate(d1.getUTCDate() - 1); const d2 = new Date(T); d2.setUTCDate(d2.getUTCDate() - 2);
    const yest = ymd(d1), cut = ymd(d2), fils = wf.map(x => x.fil);
    const per = []; for (let k = 2; k >= 0; k--) per.push(new Date(Date.UTC(T.getUTCFullYear(), T.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
    const pid = per.map(p => p.replace('-', '')).join(','), curP = per[2].replace('-', '');
    const S = await qx(SALES);
    let salesReload, PL, DY;
    try {
      salesReload = ts(await S.ev("Timestamp(ReloadTime(),'YYYY-MM-DD hh:mm')"));
      PL = await S.cube({ qDimensions: [{ qDef: { qFieldDefs: ['ispol.report_period_id'] } }, { qDef: { qFieldDefs: ['ispol.odt'] } }],
        qMeasures: [{ qDef: { qDef: `Sum({1<[ispol.flg2]={'FTTx'},[ispol.report_period_id]={${pid}}>}[ispol.plan])` } },
                    { qDef: { qDef: `Sum({1<[ispol.flg2]={'FTTx'},[ispol.report_period_id]={${pid}}>}[ispol.naryad])` } }], qSuppressZero: true });
      const set = `{1<[1.report_period_id]={${pid}},[1.flg]={'НУ ШПД'},[1.service_class_elem_group_name]={'FTTx'}>}`;
      DY = await S.cube({ qDimensions: [{ qDef: { qFieldDefs: ['1.report_period_id'] } }, { qDef: { qFieldDefs: ['1.new_odt'] } }, { qDef: { qFieldDefs: ['=Left([1.close_date],10)'] } }],
        qMeasures: [{ qDef: { qDef: `Sum(${set} [1.sum_volume_service_count])` } }], qSuppressZero: true });
    } finally { S.close(); }
    const days = []; for (let d = new Date(per[0] + '-01T00:00:00Z'); d <= T; d.setUTCDate(d.getUTCDate() + 1)) days.push(ymd(d));
    const iOf = Object.fromEntries(days.map((d, i) => [d, i]));
    const daily = Object.fromEntries(fils.map(f => [f, days.map(() => 0)]));
    const salesCur = {}, salesCurAll = {};
    DY.forEach(r => {
      const p = r[0].qText, f = odt(r[1].qText), d = r[2].qText, n = r[3].qNum || 0;
      if (!daily[f]) return;
      if (p === curP) salesCurAll[f] = (salesCurAll[f] || 0) + n;
      if (d > cut) return;                                    // последние 2 дня — из WFM
      if (p === curP) salesCur[f] = (salesCur[f] || 0) + n;
      if (iOf[d] != null) daily[f][iOf[d]] += n;
    });
    const iT = days.length - 1;
    wf.forEach(x => { daily[x.fil][iT] = x.doneToday; daily[x.fil][iT - 1] = x.doneYesterday; });
    const plan = {}, fact = {};
    PL.forEach(r => { const p = r[0].qText.slice(0, 4) + '-' + r[0].qText.slice(4), f = odt(r[1].qText);
      (plan[p] = plan[p] || {})[f] = (plan[p][f] || 0) + (r[2].qNum || 0);
      (fact[p] = fact[p] || {})[f] = (fact[p][f] || 0) + (r[3].qNum || 0); });
    const rows = wf.map(x => ({ ...x, doneMonth: (salesCur[x.fil] || 0) + x.doneYesterday + x.doneToday,
      plan: (plan[per[2]] || {})[x.fil] || 0, salesFact: salesCurAll[x.fil] || 0 }));
    const months = per.map((p, k) => ({ key: p, plan: plan[p] || {}, done: k < 2 ? (fact[p] || {}) : Object.fromEntries(rows.map(r => [r.fil, r.doneMonth])) }));
    const now = new Date(); const built = `${ymd(new Date(now - now.getTimezoneOffset() * 60000))}T${hm()}`;
    const data = {
      source: 'Qlik Sense · WFM ДИР — Аналитика', asOf, lastEvent, createdAsOf, salesReload,
      factCut: cut, factRule: `Факт = наряды из отчёта по продажам по ${cut} включительно + выполнено по WFM за ${yest} и ${today}`,
      filters: 'закладка «устгпон1» (кнопка «Установка GPON»): Segment = B2C; виды работ — монтаж линий FTTH (ВЛС/КЛС/ПЛС), FТТН, ETTH; 55 пулов; 9 статусов',
      planSource: `Qlik Sense · Отчёт по продажам Core-услуги: Показатель «НУ ШПД», Услуга «FTTx», отчётный период ${curP}`,
      planRemap: 'Улытауская область → Карагандинская ОДТ, Жетысуская область → Алматинская ОДТ, Абайская область → Семипалатинск (по пулам WFM)',
      planPeriod: per[2], rows, days, daily, months, builtAt: built };
    if (forced) data.forced = forced;
    if (sendTo) data.sendTo = String(sendTo);
    // проверка здравого смысла, как в parse_qlik.py
    const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
    if (rows.length < 15 || sum('total') <= 0 || sum('plan') <= 0) throw new Error(`странные данные: ОДТ ${rows.length}, очередь ${sum('total')}, план ${sum('plan')}`);
    return { data, summary: `WFM ${asOf.slice(11)} · факт ${sum('doneMonth')} из ${sum('plan')} (${Math.round(sum('doneMonth') / sum('plan') * 100)}%)` };
  }

  // ---------- публикация в GitHub ----------
  async function siteAsOf() { const f = await gh('GET', 'contents/data.json?ref=main'); return { sha: f.sha, asOf: JSON.parse(unb64(f.content)).asOf }; }
  async function publish(data, forced, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { sha } = await siteAsOf();
      try {
        await gh('PUT', 'contents/data.json', { message: message || `Данные на ${data.asOf.replace('T', ' ')}${forced ? ' (по запросу из Telegram)' : ''}`,
          content: b64(JSON.stringify(data)), sha, branch: 'main' });
        GM_setValue('publishedAsOf', data.asOf); return;
      } catch (e) { if (!/409|422/.test(e.message) || attempt === 2) throw e; }   // кто-то успел обновить — повторить
    }
  }

  // Сессия Qlik истекла (например, вкладка открыта со вчера): перезагружаем вкладку без старого qlikTicket —
  // вход происходит заново автоматически, а отложенный запрос выполняется сразу после перезагрузки.
  function relogin(pending) {
    const last = GM_getValue('lastRelogin', 0);
    if (Date.now() - last < 10 * 60000) return false;            // не чаще раза в 10 минут — защита от цикла
    GM_setValue('lastRelogin', Date.now());
    if (pending) GM_setValue('pendingRun', Object.assign({ at: Date.now() }, pending));
    log('сессия Qlik истекла — перезахожу в Qlik…');
    setTimeout(() => { location.href = location.origin + location.pathname; }, 1500);
    return true;
  }

  let busy = false;
  async function runUpdate({ forced = null, chats = [], sendTo = null } = {}) {
    if (busy) { log('уже идёт обновление'); return; }
    if (!cfg().gh) { log('нет токена GitHub — откройте настройки'); return; }
    busy = true;
    try {
      log(forced ? `обновляю по запросу (${forced})…` : 'WFM перезагрузился — обновляю…');
      const { data, summary } = await buildData(forced, sendTo);
      await publish(data, !!forced);
      log(`опубликовано: ${summary}`);
    } catch (e) {
      log('ошибка: ' + e.message);
      if (e.message.startsWith(QLIK_LOST) && relogin({ forced, chats, sendTo })) return;   // повторим после перевхода
      for (const c of chats) { try { await tg('sendMessage', { chat_id: c, text: `⚠️ Не удалось обновить данные: ${e.message}. Проверьте, что ноутбук включён и в Chrome открыт Qlik.` }); } catch (_) {} }
    } finally { busy = false; }
  }

  // ---------- проверка перезагрузки WFM ----------
  async function checkWfm() {
    if (!isLeader()) { setHead('ждёт: работает другая вкладка Qlik'); return; }
    const h = new Date().getHours(); if (h < AUTO_FROM || h > AUTO_TO) { setHead('ночью авто-обновления выключены'); return; }
    if (!cfg().gh) { setHead('нет токена GitHub — откройте настройки'); return; }
    try {
      const rt = await wfmReloadTime();
      let pub = GM_getValue('publishedAsOf', '');
      if (!pub) { pub = (await siteAsOf()).asOf; GM_setValue('publishedAsOf', pub); }
      if (rt > pub) await runUpdate({});
      else setHead(`данные актуальны (WFM ${rt.slice(11)}), проверка в ${new Date(Date.now() + WFM_CHECK_MS).toTimeString().slice(0, 5)}`);
    } catch (e) { log('проверка WFM: ' + e.message); if (e.message.startsWith(QLIK_LOST)) relogin(null); }
  }

  // ---------- подписчики (subscribers.json в репозитории: только числовые ID) ----------
  let subs = null, subsSha = null, subsAt = 0;
  async function loadSubs(force) {
    if (!force && subs && Date.now() - subsAt < 600000) return subs;
    try { const f = await gh('GET', 'contents/subscribers.json?ref=main'); subsSha = f.sha; subs = (JSON.parse(unb64(f.content)).subscribers || []).map(s => String(s.id)); }
    catch (e) { if (/404/.test(e.message)) { subs = []; subsSha = null; } else throw e; }
    subsAt = Date.now(); return subs;
  }
  async function saveSubs(list, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = { message, branch: 'main', content: b64(JSON.stringify({ subscribers: list.map(id => ({ id: Number(id) || id })) }, null, 1)) };
        if (subsSha) body.sha = subsSha;
        const r = await gh('PUT', 'contents/subscribers.json', body); subsSha = r.content.sha; subs = list; subsAt = Date.now(); return;
      } catch (e) { if (!/409|422/.test(e.message) || attempt === 2) throw e; await loadSubs(true); list = [...new Set([...subs, ...list])]; }
    }
  }
  const admins = () => cfg().chats.split(',').map(s => s.trim()).filter(Boolean);
  async function isAllowed(chat) { return admins().includes(chat) || (await loadSubs()).includes(chat); }

  // ---------- /svodka: последние данные — только запросившему ----------
  async function sendSummaryTo(chat) {
    const f = await gh('GET', 'contents/data.json?ref=main');
    const data = JSON.parse(unb64(f.content));
    delete data.forced; data.sendTo = chat;
    data.builtAt = `${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}T${hm()}`;
    await publish(data, false, `Сводка по запросу (данные на ${data.asOf.replace('T', ' ')})`);
  }

  const HELP = 'Команды бота FTTx:\n/svodka — сводка по последним данным (придёт через ~1 минуту)\n/update — забрать свежие данные из Qlik и прислать сводку (1–2 минуты)\n/stop — отписаться от рассылки\n/help — эта справка';
  const send = (chat, text, extra) => tg('sendMessage', Object.assign({ chat_id: chat, text }, extra || {})).catch(e => log('Telegram: ' + e.message));

  async function handle(u) {
    const cb = u.callback_query, m = u.message;
    if (cb) {
      const chat = String(cb.message.chat.id), data = cb.data || '';
      const ack = text => tg('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
      if (data === 'update') {
        if (!(await isAllowed(chat))) return ack('Нет доступа — отправьте боту /start');
        if (busy) return ack('Обновление уже идёт');
        ack('Обновляю…');
        const who = cb.from.first_name || cb.from.username || '?';
        send(chat, `⏳ Забираю последние данные из Qlik — сводка придёт через 1–2 минуты.`);
        return runUpdate({ forced: `${who}, ${hm()}`, chats: [chat], sendTo: chat });
      }
      const mm = data.match(/^(approve|deny):(-?\d+)$/);
      if (mm) {
        if (!admins().includes(chat)) return ack('Одобрять может только администратор');
        const id = mm[2], pend = GM_getValue('pending', {}); const name = (pend[id] || {}).name || id;
        delete pend[id]; GM_setValue('pending', pend);
        if (mm[1] === 'approve') {
          const list = await loadSubs(true);
          if (!list.includes(id)) await saveSubs([...list, id], 'Подписчик бота: добавлен');
          ack('Доступ открыт');
          tg('editMessageText', { chat_id: chat, message_id: cb.message.message_id, text: `✅ ${name} получил(а) доступ к сводкам` }).catch(() => {});
          await send(id, '✅ Доступ открыт. Вы будете получать сводки FTTx после каждого обновления данных.\n\n' + HELP);
          await sendSummaryTo(id).catch(e => log('сводка новому участнику: ' + e.message));
        } else {
          ack('Отклонено');
          tg('editMessageText', { chat_id: chat, message_id: cb.message.message_id, text: `❌ Запрос ${name} отклонён` }).catch(() => {});
          send(id, 'Запрос на доступ к сводкам FTTx отклонён.');
        }
      }
      return;
    }
    if (!m || !m.text) return;
    const chat = String(m.chat.id), txt = m.text.trim().toLowerCase().replace(/@\w+$/, '').replace(/@\w+\s/, ' ');
    const from = m.from || {}, name = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` (@${from.username})` : '');
    const allowed = await isAllowed(chat);
    if (/^\/start/.test(txt)) {
      if (allowed) { await send(chat, 'Вы уже подключены к сводкам FTTx.\n\n' + HELP); return sendSummaryTo(chat); }
      const pend = GM_getValue('pending', {});
      if (pend[chat]) return send(chat, 'Запрос уже отправлен администратору — дождитесь одобрения.');
      pend[chat] = { name: name || chat, at: Date.now() }; GM_setValue('pending', pend);
      await send(chat, 'Здравствуйте! Бот присылает сводку по новым установкам FTTx. Запрос на доступ отправлен администратору — после одобрения придёт первая сводка.');
      const kind = m.chat.type === 'private' ? '' : ` (чат «${m.chat.title || chat}»)`;
      for (const a of admins().slice(0, 1)) await send(a, `🆕 ${name || 'Новый участник'}${kind} просит доступ к сводкам FTTx.`, {
        reply_markup: { inline_keyboard: [[{ text: '✅ Разрешить', callback_data: `approve:${chat}` }, { text: '❌ Отклонить', callback_data: `deny:${chat}` }]] } });
      return;
    }
    if (!allowed) return send(chat, 'Чтобы получать сводки FTTx, отправьте /start — запрос уйдёт администратору.');
    if (/^\/(svodka|summary)|^сводка/.test(txt)) { await send(chat, '📊 Готовлю сводку по последним данным — придёт через ~1 минуту.'); return sendSummaryTo(chat); }
    if (/^\/(update|obnovit)|^обнови/.test(txt)) {
      if (busy) return send(chat, 'Обновление уже идёт — сводка скоро придёт.');
      await send(chat, '⏳ Забираю последние данные из Qlik — сводка придёт через 1–2 минуты.');
      return runUpdate({ forced: `${from.first_name || '?'}, ${hm()}`, chats: [chat], sendTo: chat });
    }
    if (/^\/stop/.test(txt)) {
      if (admins().includes(chat)) return send(chat, 'Этот чат указан в настройках бота как основной — отключить его можно только в настройках.');
      const list = await loadSubs(true);
      await saveSubs(list.filter(x => x !== chat), 'Подписчик бота: отписался');
      return send(chat, 'Вы отписались от сводок FTTx. Вернуться — /start.');
    }
    if (/^\/help/.test(txt)) return send(chat, HELP);
  }

  async function pollTelegram() {
    let menuSet = false;
    while (true) {
      try {
        const c = cfg();
        if (!c.tg || !c.gh || !isLeader()) { await new Promise(r => setTimeout(r, 30000)); continue; }
        if (!menuSet) {
          await tg('setMyCommands', { commands: [
            { command: 'svodka', description: 'Сводка по последним данным' },
            { command: 'update', description: 'Свежие данные из Qlik + сводка' },
            { command: 'start', description: 'Подключиться к сводкам' },
            { command: 'stop', description: 'Отписаться' },
            { command: 'help', description: 'Справка' }] }).catch(() => {});
          menuSet = true;
        }
        const ups = await tg('getUpdates', { offset: GM_getValue('tgOffset', 0), timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
        if (!ups.length) continue;
        GM_setValue('tgOffset', ups[ups.length - 1].update_id + 1);
        for (const u of ups) { try { await handle(u); } catch (e) { log('Telegram-команда: ' + e.message); } }
      } catch (e) {
        log('Telegram: ' + e.message);
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  // ---------- старт ----------
  setHead(cfg().gh ? 'запущен' : 'нет настроек — значок Tampermonkey → «FTTx-бот: настройки»');
  setTimeout(async () => {
    const p = GM_getValue('pendingRun', null);
    if (p) { GM_setValue('pendingRun', null); if (Date.now() - p.at < 15 * 60000 && isLeader()) { log('перезашла в Qlik — выполняю отложенный запрос'); await runUpdate(p); } }
    checkWfm();
  }, 8000);
  setInterval(checkWfm, WFM_CHECK_MS);
  setInterval(() => { if (GM_getValue('leader', {}).tab === TAB) GM_setValue('leader', { tab: TAB, ts: Date.now() }); }, 30000);
  pollTelegram();
})();
