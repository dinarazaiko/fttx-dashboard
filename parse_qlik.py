"""Собирает data.json из компактной выгрузки сборщика (строки META/R/M/D)."""
import json, sys, datetime as dt
src, out = sys.argv[1], sys.argv[2]
fix = lambda s: s[:10] + 'T' + s[11:] if len(s) > 10 else s
meta = None; rows = []; months = []; D = {}
for line in open(src, encoding='utf-8').read().strip().splitlines():
    p = line.split('|')
    if p[0] == 'META': meta = p[1:]
    elif p[0] == 'R':
        rows.append(dict(rdt=p[1], fil=p[2], total=int(p[3]), clean=int(p[4]), createdToday=int(p[5]), doneToday=int(p[6]),
                         doneYesterday=int(p[7]), doneMonth=int(p[8]), plan=int(p[9]), salesFact=int(p[10])))
    elif p[0] == 'M': months.append((p[1], p[2]))
    elif p[0] == 'D': D[int(p[1])] = list(map(int, p[2].split(',')))
asOf, lastEvent, createdAsOf, salesReload, cut, d0, dN = [fix(x) for x in meta]
days = []; d = dt.date.fromisoformat(d0)
while d <= dt.date.fromisoformat(dN): days.append(d.isoformat()); d += dt.timedelta(1)
F = [r['fil'] for r in rows]
assert len(D) == len(F) and all(len(v) == len(days) for v in D.values())
daily = {F[i]: D[i] for i in range(len(F))}
mo = []
for key, s in months:
    pr = s.split(','); assert len(pr) == len(F)
    mo.append(dict(key=key, plan={F[i]: int(x.split(':')[0]) for i, x in enumerate(pr)}, done={F[i]: int(x.split(':')[1]) for i, x in enumerate(pr)}))
y = (dt.date.fromisoformat(dN) - dt.timedelta(1)).isoformat()
for r in rows:   # проверка: факт месяца = наряды по cut + WFM вчера и сегодня
    assert daily[r['fil']][-1] == r['doneToday'] and daily[r['fil']][-2] == r['doneYesterday']
data = dict(source='Qlik Sense · WFM ДИР — Аналитика', asOf=asOf, lastEvent=lastEvent, createdAsOf=createdAsOf, salesReload=salesReload,
    factCut=cut, factRule=f'Факт = наряды из отчёта по продажам по {cut} включительно + выполнено по WFM за {y} и {dN}',
    filters='закладка «устгпон1» (кнопка «Установка GPON»): Segment = B2C; виды работ — монтаж линий FTTH (ВЛС/КЛС/ПЛС), FТТН, ETTH; 55 пулов; 9 статусов',
    planSource=f'Qlik Sense · Отчёт по продажам Core-услуги: Показатель «НУ ШПД», Услуга «FTTx», отчётный период {mo[-1]["key"].replace("-","")}',
    planRemap='Улытауская область → Карагандинская ОДТ, Жетысуская область → Алматинская ОДТ, Абайская область → Семипалатинск (по пулам WFM)',
    planPeriod=mo[-1]['key'], rows=rows, days=days, daily=daily, months=mo)
json.dump(data, open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('ok', asOf, 'odt', len(rows), 'days', len(days), 'total', sum(r['total'] for r in rows), 'clean', sum(r['clean'] for r in rows),
      'doneMonth', sum(r['doneMonth'] for r in rows), 'plan', sum(r['plan'] for r in rows),
      'sep', sum(mo[0]['done'].values()), 'oct', sum(mo[1]['done'].values()))
