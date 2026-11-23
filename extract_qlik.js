// Сборщик data.json для сайта «Новые установки FTTx».
// Запускается в любой вкладке https://qtest/... (нужна действующая сессия Qlik).
// Работает напрямую с движком Qlik по WebSocket, интерфейс листа не нужен.
// Результат: window.__fttx (объект) и window.__fttxGz (base64 от gzip JSON) для выгрузки частями.
await (async () => {
  const WFM = '49bbf2a0-a537-400e-8e47-2d311df1f1e9';
  const SALES = 'e1e154eb-0977-4e66-8526-ad52a159a455';
  const BOOKMARK = 'c91dbe08-d09b-42d4-b5a9-d2e49f32902c';   // «устгпон1», кнопка «Установка GPON»
  const PIVOT = 'dd53892d-c27a-49a7-b1f5-b2939e8d278e';      // «Заказы в разрезе регионов»
  const REMAP = { 'Абайская область': 'Семипалатинск', 'Жетысуская область': 'Алматинская ОДТ', 'Улытауская область': 'Карагандинская ОДТ' };
  const odt = n => REMAP[n] || n;

  const qx = async (appId) => {
    const ws = new WebSocket(`wss://${location.host}/app/${appId}?reloadUri=x`);
    let id = 0; const pend = {};
    ws.onmessage = e => { const j = JSON.parse(e.data); if (j.id && pend[j.id]) { j.error ? pend[j.id].rej(j.error) : pend[j.id].res(j.result); delete pend[j.id]; } };
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const call = (h, m, p) => new Promise((res, rej) => { const i = ++id; pend[i] = { res, rej }; ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, handle: h, method: m, params: p })); });
    const doc = (await call(-1, 'OpenDoc', [appId])).qReturn.qHandle;
    const ev = async ex => (await call(doc, 'Evaluate', [ex])).qReturn;
    const cube = async (def, w) => {
      const o = (await call(doc, 'CreateSessionObject', [{ qInfo: { qType: 'x' }, qHyperCubeDef: def }])).qReturn.qHandle;
      const lay = (await call(o, 'GetLayout', [])).qLayout.qHyperCube;
      const rows = []; const W = lay.qSize.qcx, H = lay.qSize.qcy, step = Math.floor(10000 / W);
      for (let top = 0; top < H; top += step) {
        const pg = (await call(o, 'GetHyperCubeData', ['/qHyperCubeDef', [{ qTop: top, qLeft: 0, qWidth: W, qHeight: Math.min(step, H - top) }]])).qDataPages[0];
        pg.qMatrix.forEach(r => rows.push(r));
      }
      return { rows, total: lay.qGrandTotalRow };
    };
    return { ws, call, doc, ev, cube };
  };
  const ymd = d => d.toISOString().slice(0, 10);

  // ---------- WFM
  const W = await qx(WFM);
  await W.call(W.doc, 'ApplyBookmark', [BOOKMARK]);
  const pv = (await W.call(W.doc, 'GetObject', [PIVOT])).qReturn.qHandle;
  const P = (await W.call(pv, 'GetProperties', [])).qProp.qHyperCubeDef;
  const today = await W.ev("Date(Today(),'YYYY-MM-DD')");
  const T = new Date(today + 'T00:00:00Z');
  const d1 = new Date(T); d1.setUTCDate(d1.getUTCDate() - 1);
  const d2 = new Date(T); d2.setUTCDate(d2.getUTCDate() - 2);
  const yest = ymd(d1), cut = ymd(d2);                        // наряды берём по cut включительно
  const done = d => `Count({$<state_name=, state_name={'Выполнено'}, last_state_ts={"${d}*"}>} DISTINCT siebel_order_id)`;
  const A = await W.cube({
    qDimensions: [{ qDef: { qFieldDefs: P.qDimensions[0].qDef.qFieldDefs } }, { qDef: { qFieldDefs: P.qDimensions[1].qDef.qFieldDefs } }],
    qMeasures: [
      { qDef: { qDef: P.qMeasures[0].qDef.qDef } }, { qDef: { qDef: P.qMeasures[1].qDef.qDef } },
      { qDef: { qDef: "Count({$<state_name=>} DISTINCT If(Floor(wfm_create_ts)=Floor(Today()), siebel_order_id))" } },
      { qDef: { qDef: done(today) } }, { qDef: { qDef: done(yest) } }
    ]
  });
  const asOf = await W.ev("Timestamp(ReloadTime(),'YYYY-MM-DDThh:mm')");
  const lastEvent = (await W.ev("MaxString({$<state_name=, state_name={'Выполнено'}>} last_state_ts)")).slice(0, 16).replace(' ', 'T');
  const createdAsOf = await W.ev("Timestamp({$<state_name=>} Max(wfm_create_ts),'YYYY-MM-DDThh:mm')");
  W.ws.close();
  const wf = A.rows.filter(r => r[1].qText !== '-' && r[0].qText !== '-').map(r => ({
    rdt: r[0].qText, fil: r[1].qText, total: r[2].qNum, clean: r[3].qNum, createdToday: r[4].qNum, doneToday: r[5].qNum, doneYesterday: r[6].qNum
  }));
  const fils = wf.map(x => x.fil);

  // ---------- Отчёт по продажам
  const S = await qx(SALES);
  const salesReload = await S.ev("Timestamp(ReloadTime(),'YYYY-MM-DDThh:mm')");
  const per = []; for (let k = 2; k >= 0; k--) { const d = new Date(Date.UTC(T.getUTCFullYear(), T.getUTCMonth() - k, 1)); per.push(d.toISOString().slice(0, 7)); }
  const pid = per.map(p => p.replace('-', '')).join(',');
  const PL = await S.cube({
    qDimensions: [{ qDef: { qFieldDefs: ['ispol.report_period_id'] } }, { qDef: { qFieldDefs: ['ispol.odt'] } }],
    qMeasures: [{ qDef: { qDef: `Sum({1<[ispol.flg2]={'FTTx'},[ispol.report_period_id]={${pid}}>}[ispol.plan])` } },
                { qDef: { qDef: `Sum({1<[ispol.flg2]={'FTTx'},[ispol.report_period_id]={${pid}}>}[ispol.naryad])` } }],
    qSuppressZero: true
  });
  const set = `{1<[1.report_period_id]={${pid}},[1.flg]={'НУ ШПД'},[1.service_class_elem_group_name]={'FTTx'}>}`;
  const DY = await S.cube({
    qDimensions: [{ qDef: { qFieldDefs: ['1.report_period_id'] } }, { qDef: { qFieldDefs: ['1.new_odt'] } }, { qDef: { qFieldDefs: ['=Left([1.close_date],10)'] } }],
    qMeasures: [{ qDef: { qDef: `Sum(${set} [1.sum_volume_service_count])` } }],
    qSuppressZero: true
  });
  S.ws.close();

  // ---------- Сборка
  const first = new Date(per[0] + '-01T00:00:00Z'); const days = [];
  for (let d = new Date(first); d <= T; d.setUTCDate(d.getUTCDate() + 1)) days.push(ymd(d));
  const iOf = Object.fromEntries(days.map((d, i) => [d, i]));
  const daily = Object.fromEntries(fils.map(f => [f, days.map(() => 0)]));
  const salesCur = {}; const salesCurAll = {};
  const curP = per[2].replace('-', '');
  DY.rows.forEach(r => {
    const p = r[0].qText, f = odt(r[1].qText), d = r[2].qText, n = r[3].qNum || 0;
    if (!daily[f]) return;
    if (p === curP) salesCurAll[f] = (salesCurAll[f] || 0) + n;
    if (d > cut) return;                                         // последние 2 дня — из WFM
    if (p === curP) salesCur[f] = (salesCur[f] || 0) + n;
    if (iOf[d] != null) daily[f][iOf[d]] += n;
  });
  const iT = days.length - 1;
  wf.forEach(x => { daily[x.fil][iT] = x.doneToday; daily[x.fil][iT - 1] = x.doneYesterday; });
  const plan = {}, fact = {};
  PL.rows.forEach(r => { const p = r[0].qText.slice(0, 4) + '-' + r[0].qText.slice(4), f = odt(r[1].qText);
    (plan[p] = plan[p] || {})[f] = ((plan[p] || {})[f] || 0) + (r[2].qNum || 0);
    (fact[p] = fact[p] || {})[f] = ((fact[p] || {})[f] || 0) + (r[3].qNum || 0); });
  const rows = wf.map(x => ({ ...x,
    doneMonth: (salesCur[x.fil] || 0) + x.doneYesterday + x.doneToday,
    plan: (plan[per[2]] || {})[x.fil] || 0,
    salesFact: salesCurAll[x.fil] || 0 }));
  const months = per.map((p, k) => ({ key: p, plan: plan[p] || {},
    done: k < 2 ? (fact[p] || {}) : Object.fromEntries(rows.map(r => [r.fil, r.doneMonth])) }));
  const data = {
    source: 'Qlik Sense · WFM ДИР — Аналитика', asOf, lastEvent, createdAsOf, salesReload,
    factCut: cut, factRule: `Факт = наряды из отчёта по продажам по ${cut} включительно + выполнено по WFM за ${yest} и ${today}`,
    filters: 'закладка «устгпон1» (кнопка «Установка GPON»): Segment = B2C; spec_name — монтаж линий FTTH (ВЛС/КЛС/ПЛС), FТТН, ETTH; 55 пулов; 9 статусов',
    planSource: `Qlik Sense · Отчёт по продажам Core-услуги: Показатель «НУ ШПД», Услуга «FTTx», отчётный период ${curP}`,
    planRemap: 'Улытауская область → Карагандинская ОДТ, Жетысуская область → Алматинская ОДТ, Абайская область → Семипалатинск (по пулам WFM)',
    planPeriod: per[2], rows, days, daily, months
  };
  window.__fttx = data;
  const gz = await new Response(new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  let s = ''; new Uint8Array(gz).forEach(b => s += String.fromCharCode(b));
  window.__fttxGz = btoa(s);
  return { asOf, salesReload, cut, odt: rows.length, days: days.length, gzLen: window.__fttxGz.length,
           total: rows.reduce((a, r) => a + r.total, 0), clean: rows.reduce((a, r) => a + r.clean, 0),
           doneMonth: rows.reduce((a, r) => a + r.doneMonth, 0), plan: rows.reduce((a, r) => a + r.plan, 0) };
})()
