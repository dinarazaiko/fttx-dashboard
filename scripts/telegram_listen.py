#!/usr/bin/env python3
"""Ловит в Telegram запрос «обновить сейчас» и запускает задачу обновления данных из Qlik.

Запрос — кнопка «🔄 Обновить сейчас» под сводкой или команда /update.
Принимаются только чаты из TELEGRAM_CHAT_ID. Несколько нажатий за одну проверку
запускают задачу один раз. Задача сама соберёт последние данные из Qlik, закоммитит
data.json, а GitHub Action «FTTx — сводка в Telegram» пришлёт свежую сводку.

Переменные: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (через запятую),
            ROUTINE_FIRE_URL, ROUTINE_FIRE_TOKEN (claude.ai/code/routines → API-триггер).
"""
import json, os, sys, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=5))   # Asia/Qyzylorda


def tg(token, method, fields):
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}",
                                 data=json.dumps(fields).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)
    if not res.get("ok"):
        raise RuntimeError(f"Telegram {method}: {res}")
    return res.get("result")


def fire(url, token, text):
    req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(), headers={
        "Authorization": f"Bearer {token}", "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return True, json.load(r)
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}"
    except Exception as e:  # сеть и т.п.
        return False, str(e)


def main():
    token = os.environ["TELEGRAM_BOT_TOKEN"].strip()
    allowed = {c.strip() for c in os.environ.get("TELEGRAM_CHAT_ID", "").split(",") if c.strip()}
    fire_url = os.environ.get("ROUTINE_FIRE_URL", "").strip()
    fire_token = os.environ.get("ROUTINE_FIRE_TOKEN", "").strip()

    updates = tg(token, "getUpdates", {"timeout": 0, "allowed_updates": ["message", "callback_query"]})
    if not updates:
        print("Запросов нет"); return
    requests = []                                   # (chat_id, кто, callback_id)
    for u in updates:
        cb = u.get("callback_query")
        if cb and cb.get("data") == "update":
            chat = str(cb["message"]["chat"]["id"])
            who = cb["from"].get("first_name") or cb["from"].get("username") or "?"
            if chat in allowed:
                requests.append((chat, who, cb["id"]))
            else:
                tg(token, "answerCallbackQuery", {"callback_query_id": cb["id"], "text": "Этот чат не может запускать обновление"})
            continue
        m = u.get("message") or {}
        txt = (m.get("text") or "").strip().lower()
        if txt.startswith("/update") or txt.startswith("/obnovit") or txt in ("обновить", "обнови"):
            chat = str(m["chat"]["id"])
            who = (m.get("from") or {}).get("first_name") or "?"
            if chat in allowed:
                requests.append((chat, who, None))
    # подтвердить получение всех апдейтов, чтобы следующий запуск их не видел
    tg(token, "getUpdates", {"offset": updates[-1]["update_id"] + 1, "timeout": 0, "limit": 1})
    if not requests:
        print(f"Апдейтов: {len(updates)}, запросов на обновление нет"); return

    now = datetime.now(TZ).strftime("%H:%M")
    names = ", ".join(sorted({w for _, w, _ in requests}))
    if not (fire_url and fire_token):
        ok, info = False, "не заданы секреты ROUTINE_FIRE_URL и ROUTINE_FIRE_TOKEN"
    else:
        ok, info = fire(fire_url, fire_token,
                        f"ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ из Telegram: запросил(а) {names} в {now}. "
                        f"Обнови данные, даже если WFM с прошлого раза не перезагружался; для parse_qlik.py "
                        f"используй --forced \"{names}, {now}\".")
    print("Запуск задачи:", ok, info)
    text = (f"⏳ Запрос от {names} принят в {now}. Забираю последние данные из Qlik — "
            f"сводка придёт сюда примерно через 5–7 минут." if ok else
            f"⚠️ Не удалось запустить обновление: {info}")
    for chat in sorted({c for c, _, _ in requests}):
        tg(token, "sendMessage", {"chat_id": chat, "text": text})
    for _, _, cb_id in requests:
        if cb_id:
            try:
                tg(token, "answerCallbackQuery", {"callback_query_id": cb_id,
                                                  "text": "Обновление запущено" if ok else "Ошибка запуска"})
            except Exception:
                pass   # кнопка могла устареть — не страшно
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
