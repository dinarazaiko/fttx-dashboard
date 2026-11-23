# Как обновить данные

1. В Chrome открыть любую страницу `https://qtest/...` (нужна сессия Qlik).
2. Выполнить в этой вкладке код `extract_qlik.js` целиком (DevTools → Console или через Claude). Он вернёт `{asOf, ..., chunks: N}`.
3. Прочитать `window.__ch[0]` … `window.__ch[N-1]`, сложить подряд в один текстовый файл.
4. `python3 parse_qlik.py выгрузка.txt data.json` — соберёт `data.json` и проверит его.
5. Заменить `data.json` в репозитории.
