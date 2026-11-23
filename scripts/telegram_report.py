#!/usr/bin/env python3
"""Telegram-бот «Новые установки FTTx»: сводка по очереди, выполнению и плану.

Берёт тот же data.json, что и сайт, считает по тем же правилам (раздел 4 PRD)
и отправляет в Telegram короткую сводку + Excel-файл (листы «Сводка» и
«Выполнено по дням»).

Правила (как на сайте):
    Остаток      = max(0, план − выполнено с начала месяца)
    Нужно в день = остаток ÷ оставшиеся рабочие дни (пн–сб, сегодня включён), вверх
    Ср. раб. день = среднее за последние 6 полных дней без воскресений
    Прогноз      = выполнено по вчера + ср. раб. день × оставшиеся раб. дни
                   + среднее двух последних воскресений × оставшиеся воскресенья
    Цвет: 🟢 ≥100%, 🟡 90–99%, 🔴 <90%

Запуск:
    python scripts/telegram_report.py                         # собрать сообщение и Excel в out/
    TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... python scripts/telegram_report.py --send
    TELEGRAM_BOT_TOKEN=... python scripts/telegram_report.py --chat-ids   # узнать chat_id
"""
import argparse, calendar, html, json, math, os, re, sys, urllib.request, uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
       "сентября", "октября", "ноября", "декабря"]
MONN = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август",
        "сентябрь", "октябрь", "ноябрь", "декабрь"]
WD = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
TZ = timezone(timedelta(hours=5))          # Asia/Qyzylorda
STALE_HOURS = 3                            # предупреждать, если данные старше
KEYS = ["total", "clean", "createdToday", "doneToday", "doneYesterday", "doneMonth",
        "avg", "avgSun", "plan", "salesFact"]


def pd(s):
    return date.fromisoformat(s[:10])


def n(v):
    return f"{round(v):,}".replace(",", " ")


def dlabel(s):
    d = pd(s)
    return f"{d.day} {MON[d.month - 1]}"


def band(p):
    return "⚪" if p is None else "🟢" if p >= 100 else "🟡" if p >= 90 else "🔴"


# ---------- модель (повторяет model() на сайте) ----------
def model(D):
    days = D["days"]; T = len(days) - 1          # последний день — сегодня, неполный
    is_sun = [pd(s).weekday() == 6 for s in days]
    work = [i for i in range(T - 1, -1, -1) if not is_sun[i]][:6]
    suns = [i for i in range(T - 1, -1, -1) if is_sun[i]][:2]
    t0 = pd(days[T]); m_end = calendar.monthrange(t0.year, t0.month)[1]
    rem_w = rem_s = 0
    for d in range(t0.day, m_end + 1):
        if date(t0.year, t0.month, d).weekday() == 6: rem_s += 1
        else: rem_w += 1

    def fin(o):
        o["other"] = o["total"] - o["clean"]
        o["pct"] = o["doneMonth"] / o["plan"] * 100 if o["plan"] > 0 else None
        o["fc"] = o["doneMonth"] - o["doneToday"] + o["avg"] * rem_w + o["avgSun"] * rem_s
        o["fcPct"] = o["fc"] / o["plan"] * 100 if o["plan"] > 0 else None
        o["rest"] = max(0, o["plan"] - o["doneMonth"])
        o["needDay"] = math.ceil(o["rest"] / (rem_w or 1)) if o["plan"] > 0 else None
        return o

    fils = []
    for r in D["rows"]:
        v = D["daily"].get(r["fil"]) or [0] * len(days)
        avg = sum(v[i] for i in work) / len(work) if work else 0
        avg_sun = sum(v[i] for i in suns) / len(suns) if suns else 0
        fils.append(fin({**r, "v": v, "avg": avg, "avgSun": avg_sun}))

    def total(lst):
        o = {k: sum(f.get(k) or 0 for f in lst) for k in KEYS}
        o["v"] = [sum(f["v"][i] for f in lst) for i in range(len(days))]
        return fin(o)

    regs = []
    for rdt in sorted({f["rdt"] for f in fils}):
        fl = sorted([f for f in fils if f["rdt"] == rdt], key=lambda f: f["fil"])
        regs.append({"rdt": rdt, "fils": fl, **total(fl)})
    return {"D": D, "days": days, "T": T, "is_sun": is_sun, "rem_w": rem_w, "rem_s": rem_s,
            "fils": fils, "regs": regs, "all": total(fils)}


# ---------- сообщение ----------
def message(M, site=""):
    D, s, T = M["D"], M["all"], M["T"]
    today = pd(M["days"][T]); mon, monn = MON[today.month - 1], MONN[today.month - 1]
    as_of = D["asOf"][11:16]
    L = [f"<b>FTTx · новые установки на {dlabel(M['days'][T])}, {as_of}</b>"]

    stale = datetime.now(TZ).replace(tzinfo=None) - datetime.fromisoformat(D["asOf"])
    if stale > timedelta(hours=STALE_HOURS):
        L.append(f"⚠️ Данные не обновлялись {stale.days * 24 + stale.seconds // 3600} ч — "
                 f"проверьте сессию Qlik.")

    pct = lambda p: "—" if p is None else f"{round(p)}%"
    num = lambda v: "—" if v is None else n(v)

    # таблица по регионам: моноширинная, ширина ≤ 36 символов — влезает в экран телефона
    def table(cols, tail=None):
        """cols: [(заголовок, ширина, функция(o) -> str)]; tail(o) — текст после таблицы (эмодзи)."""
        W = 6
        out = [f"{'':<{W}}" + "".join(f"{h:>{w}}" for h, w, _ in cols)]
        for name, o in [(r["rdt"], r) for r in M["regs"]] + [("Итого", s)]:
            row = f"{name[:W]:<{W}}" + "".join(f"{f(o):>{w}}" for _, w, f in cols)
            out.append(row + (" " + tail(o) if tail else ""))
        return "<pre>" + html.escape("\n".join(out)) + "</pre>"

    pq = s["clean"] / s["total"] * 100 if s["total"] else 0
    L += ["",
          f"⏱ <b>Сейчас, на {as_of}</b>: очередь общая <b>{n(s['total'])}</b> · чистая <b>{n(s['clean'])}</b>"
          f" ({n(pq)}%) · выполнено сегодня <b>{n(s['doneToday'])}</b>",
          table([("Общая", 7, lambda o: n(o["total"])),
                 ("Чистая", 7, lambda o: n(o["clean"])),
                 ("Выполн", 8, lambda o: n(o["doneToday"]))]),
          f"✅ <b>Выполнено</b>: вчера ({dlabel(M['days'][T - 1])}) <b>{n(s['doneYesterday'])}</b>"
          f" · с 1 {mon} <b>{n(s['doneMonth'])}</b>",
          table([("Вчера", 7, lambda o: n(o["doneYesterday"])),
                 ("С 1-го", 8, lambda o: n(o["doneMonth"]))]),
          f"🎯 <b>План на {monn}</b>: <b>{pct(s['pct'])}</b> ({n(s['doneMonth'])} из {n(s['plan'])})"
          f" · остаток <b>{n(s['rest'])}</b> · нужно в рабочий день <b>{num(s['needDay'])}</b>"
          f" · осталось раб. дней: {M['rem_w']}",
          table([("План", 7, lambda o: n(o["plan"])),
                 ("%", 5, lambda o: pct(o["pct"])),
                 ("Остат", 7, lambda o: n(o["rest"])),
                 ("Нужно", 6, lambda o: num(o["needDay"]))]),
          f"📈 <b>Прогноз</b>: {band(s['fcPct'])} <b>{pct(s['fcPct'])}</b> ({n(s['fc'])})",
          table([("Прогноз", 8, lambda o: n(o["fc"])),
                 ("%", 6, lambda o: pct(o["fcPct"]))], tail=lambda o: band(o["fcPct"]))]

    if site:
        L += ["", f'<a href="{html.escape(site)}">Открыть сайт</a>']
    return "\n".join(L)


# ---------- Excel (как кнопка «Скачать Excel» на сайте) ----------
def build_xlsx(M, path):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    red = PatternFill("solid", fgColor="FBE4E4"); amber = PatternFill("solid", fgColor="FDF1D3")
    green = PatternFill("solid", fgColor="E1F3E1"); grey = PatternFill("solid", fgColor="F0EFEC")
    bold = Font(bold=True)
    fill = lambda p: None if p is None else green if p >= 100 else amber if p >= 90 else red
    wb = Workbook()

    ws = wb.active; ws.title = "Сводка"
    ws.append([f"Новые установки FTTx на {dlabel(M['days'][M['T']])}, данные {M['D']['asOf'].replace('T', ' ')}"])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([])
    ws.append(["Регион", "ОДТ", "Очередь общая", "Очередь чистая", "Создано сегодня",
               "Выполнено сегодня", "Выполнено вчера", "Выполнено с начала месяца",
               "План", "% вып.", "Остаток", f"Нужно в день ({M['rem_w']} раб. дн.)",
               "Ср. раб. день", "Прогноз", "Прогноз %"])
    for c in ws[3]: c.font = bold; c.alignment = Alignment(wrap_text=True, vertical="top")

    def put(rdt, fil, o, strong=False):
        ws.append([rdt, fil, o["total"], o["clean"], o["createdToday"], o["doneToday"], o["doneYesterday"],
                   o["doneMonth"], o["plan"], None if o["pct"] is None else o["pct"] / 100, o["rest"],
                   o["needDay"], round(o["avg"], 1), round(o["fc"]),
                   None if o["fcPct"] is None else o["fcPct"] / 100])
        r = ws.max_row
        ws.cell(r, 10).number_format = ws.cell(r, 15).number_format = "0%"
        f = fill(o["fcPct"])
        if f: ws.cell(r, 15).fill = f
        if strong:
            for c in ws[r]:
                c.font = bold
                if c.column != 15: c.fill = grey
    for reg in M["regs"]:
        put(reg["rdt"], "", reg, True)
        for f in reg["fils"]: put(reg["rdt"], f["fil"], f)
    put("Итого", "", M["all"], True)
    for k, w in enumerate([10, 30] + [12] * 13, 1): ws.column_dimensions[get_column_letter(k)].width = w
    ws.freeze_panes = "C4"

    ws2 = wb.create_sheet("Выполнено по дням")
    t0 = pd(M["days"][M["T"]])
    idx = [i for i, s in enumerate(M["days"]) if pd(s).year == t0.year and pd(s).month == t0.month]
    ws2.append(["Регион", "ОДТ"] + [f"{pd(M['days'][i]).strftime('%d.%m')} {WD[pd(M['days'][i]).weekday()]}"
                                    for i in idx] + ["Итого за месяц", "Ср. раб. день"])
    for c in ws2[1]: c.font = bold
    for reg in M["regs"]:
        ws2.append([reg["rdt"], ""] + [reg["v"][i] for i in idx] + [reg["doneMonth"], round(reg["avg"], 1)])
        for c in ws2[ws2.max_row]: c.font = bold; c.fill = grey
        for f in reg["fils"]:
            ws2.append([reg["rdt"], f["fil"]] + [f["v"][i] for i in idx] + [f["doneMonth"], round(f["avg"], 1)])
    a = M["all"]
    ws2.append(["Итого", ""] + [a["v"][i] for i in idx] + [a["doneMonth"], round(a["avg"], 1)])
    for c in ws2[ws2.max_row]: c.font = bold; c.fill = grey
    ws2.column_dimensions["A"].width = 10; ws2.column_dimensions["B"].width = 30
    ws2.freeze_panes = "C2"
    wb.save(path)


# ---------- Telegram ----------
def tg_call(token, method, fields, file_field=None, file_path=None):
    url = f"https://api.telegram.org/bot{token}/{method}"
    if file_path is None:
        req = urllib.request.Request(url, data=json.dumps(fields).encode(),
                                     headers={"Content-Type": "application/json"})
    else:
        b = uuid.uuid4().hex; parts = []
        for k, v in fields.items():
            parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{file_field}"; '
                     f'filename="{Path(file_path).name}"\r\nContent-Type: application/vnd.openxmlformats-'
                     f'officedocument.spreadsheetml.sheet\r\n\r\n'.encode())
        parts.append(Path(file_path).read_bytes()); parts.append(f"\r\n--{b}--\r\n".encode())
        req = urllib.request.Request(url, data=b"".join(parts),
                                     headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)
    if not res.get("ok"):
        raise RuntimeError(f"Telegram {method}: {res}")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data.json", help="путь к data.json сайта")
    ap.add_argument("--out", default="out")
    ap.add_argument("--send", action="store_true", help="отправить в Telegram")
    ap.add_argument("--no-excel", action="store_true", help="не прикладывать Excel")
    ap.add_argument("--chat-ids", action="store_true", help="показать chat_id из последних сообщений боту")
    a = ap.parse_args()
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip().strip('"\'')
    if token and not re.fullmatch(r"\d+:[A-Za-z0-9_-]{30,}", token):
        sys.exit("Токен не похож на токен Telegram. Он выглядит так: 1234567890:AAGsjf6oq5n9KMj...\n"
                 "Скопируйте его из @BotFather целиком, без пробелов и русских букв, "
                 "и подставьте вместо слов «ваш_токен».")
    if a.chat_ids:
        if not token: sys.exit("Нужна переменная TELEGRAM_BOT_TOKEN")
        updates = tg_call(token, "getUpdates", {})["result"]
        if not updates:
            print("Бот пока не получил ни одного сообщения. Напишите ему /start в Telegram "
                  "(или любое сообщение в группе, куда он добавлен) и запустите команду ещё раз.")
        for u in updates:
            ch = (u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}).get("chat", {})
            if ch: print(ch.get("id"), ch.get("type"), ch.get("title") or ch.get("username") or ch.get("first_name"))
        return

    M = model(json.loads(Path(a.data).read_text(encoding="utf-8")))
    site = os.environ.get("SITE_URL", "").strip()
    msg = message(M, site)
    out = Path(a.out); out.mkdir(exist_ok=True)
    (out / "message.html").write_text(msg, encoding="utf-8")
    xlsx = None
    if not a.no_excel:
        xlsx = out / f"fttx_{M['days'][M['T']]}.xlsx"; build_xlsx(M, xlsx)
    print(msg)
    if xlsx: print(f"\nФайл: {xlsx}")

    if a.send:
        chat_ids = [c.strip() for c in os.environ.get("TELEGRAM_CHAT_ID", "").split(",") if c.strip()]
        if not token or not chat_ids:
            sys.exit("Нужны переменные TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID")
        # лимит Telegram — 4096 символов: режем по пустым строкам (таблицы <pre> не разрываются)
        parts, cur = [], ""
        for block in msg.split("\n\n"):
            if cur and len(cur) + 2 + len(block) > 4000:
                parts.append(cur); cur = block
            else:
                cur = f"{cur}\n\n{block}" if cur else block
        parts.append(cur)
        for cid in chat_ids:
            for part in parts:
                tg_call(token, "sendMessage", {"chat_id": cid, "text": part, "parse_mode": "HTML",
                                               "disable_web_page_preview": True})
            if xlsx:
                tg_call(token, "sendDocument", {"chat_id": cid, "caption": "Сводка по РДТ и ОДТ + выполнено по дням"},
                        "document", xlsx)
        print("Отправлено в чаты:", ", ".join(chat_ids))


if __name__ == "__main__":
    main()
