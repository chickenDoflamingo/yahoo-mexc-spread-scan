# Yahoo vs MEXC Spread Monitor

Локальный веб-дашборд для мониторинга спреда между Yahoo Finance и синтетическими акциями на MEXC.

## Что умеет

- автоматически запрашивает все доступные perpetual-контракты MEXC и пытается выделить среди них stock futures;
- сопоставляет тикеры MEXC с Yahoo Finance;
- обновляет снимок рынка каждые 3 секунды;
- считает `spread_abs` и `spread_pct`;
- показывает историю `spread_pct` за последние 24 часа;
- хранит историю в SQLite;
- позволяет искать тикеры, фильтровать по минимальному спреду и выгружать CSV.
- можно опубликовать через Render или Cloudflare Tunnel.

## Структура

```text
backend/
  main.py
  mexc.py
  yahoo.py
  matcher.py
  storage.py
frontend/
  index.html
  app.js
data/
  database.db
requirements.txt
```

## Установка

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Запуск

```bash
uvicorn backend.main:app --reload
```

После запуска откройте:

```text
http://127.0.0.1:8000/
```

## Публичный доступ через Render

Для стабильной ссылки удобнее использовать Render. В текущей схеме Render используется как публичная витрина, а локальный Mac может выступать источником данных для MEXC, если MEXC режет облачные IP и отдаёт `403`.

В проект уже добавлены:

- [render.yaml](/Users/mac/PycharmProjects/education/prog education/pandas education/render.yaml) с web service конфигом;
- [.python-version](/Users/mac/PycharmProjects/education/prog education/pandas education/.python-version) для Python `3.11.11`;
- переменная `SPREAD_MONITOR_DB_PATH`, чтобы путь к SQLite можно было задавать через окружение;
- ingest endpoint и feeder-скрипт [push_remote_snapshot.py](/Users/mac/PycharmProjects/education/prog education/pandas education/scripts/push_remote_snapshot.py).

Базовый сценарий:

1. Создайте Git-репозиторий и отправьте проект в GitHub.
2. В Render выберите `New +` -> `Blueprint` или `Web Service`.
3. Подключите репозиторий.
4. Для бесплатного режима оставьте:

```text
Build Command: pip install -r requirements.txt
Start Command: python3 -m uvicorn backend.main:app --host 0.0.0.0 --port $PORT
```

5. Добавьте env vars:

```text
SPREAD_MONITOR_DB_PATH=/tmp/spread-monitor.db
PUBLIC_BASIC_AUTH_USER=ваш_логин
PUBLIC_BASIC_AUTH_PASSWORD=ваш_пароль
PUBLIC_INGEST_TOKEN=длинный_секрет_для_feeder_скрипта
```

Если разворачивать через `Blueprint`, `render.yaml` уже содержит поля `PUBLIC_BASIC_AUTH_USER`, `PUBLIC_BASIC_AUTH_PASSWORD` и `PUBLIC_INGEST_TOKEN`, и Render сам попросит их заполнить.

После деплоя Render выдаст публичный URL вида `https://<service>.onrender.com`.

### Как кормить Render данными с локального Mac

Если публичный Render-сервис получает `403` от MEXC, запускайте feeder локально на Mac:

```bash
cd "/Users/mac/PycharmProjects/education/prog education/pandas education"
export REMOTE_BASE_URL="https://<service>.onrender.com"
export PUBLIC_INGEST_TOKEN="тот_же_секрет_что_в_Render"
python3 scripts/push_remote_snapshot.py
```

Feeder будет каждые 3 секунды:

- забирать MEXC и Yahoo локально;
- считать спреды;
- отправлять свежий snapshot и историю на Render через `/api/ingest/snapshot`.

Важно:

- на бесплатном плане сервис может "засыпать", поэтому мониторинг не будет полностью непрерывным;
- SQLite в бесплатном режиме будет жить во временной файловой системе, история может сбрасываться после рестарта;
- если feeder не запущен, публичный сайт останется доступным, но данные обновляться не будут;
- если нужна сохранность истории, лучше перейти на платный инстанс и вынести базу на persistent disk или отдельную БД.

## Публичный доступ через Cloudflare Tunnel

Скрипт [scripts/start_public_cloudflare.sh](/Users/mac/PycharmProjects/education/prog education/pandas education/scripts/start_public_cloudflare.sh) поднимает `uvicorn` и сразу публикует приложение через `Cloudflare Quick Tunnel`.

Защита ставится на само приложение через `Basic Auth`, поэтому ссылка остаётся рабочей для команды, но без логина и пароля сайт не откроется.

Нужно:

```bash
brew install cloudflared
```

Потом запустить:

```bash
cd "/Users/mac/PycharmProjects/education/prog education/pandas education"
export PUBLIC_BASIC_AUTH_USER="team"
export PUBLIC_BASIC_AUTH_PASSWORD="сложный_пароль_минимум_8_символов"
bash scripts/start_public_cloudflare.sh
```

Если нужен dev-режим с авто-перезагрузкой:

```bash
APP_RELOAD=1 bash scripts/start_public_cloudflare.sh
```

После запуска `cloudflared` покажет публичный `https://...trycloudflare.com` URL. Его можно раздавать команде вместе с логином и паролем.

Важно:

- `Quick Tunnel` даёт случайный временный URL, он может измениться после перезапуска;
- если потом понадобится постоянный адрес на своём домене, можно перевести это на именованный Cloudflare Tunnel.

## Примечания

- История начинает заполняться после первого успешного цикла обновления.
- Первый полный снимок после запуска может собираться до минуты: MEXC подтягивается быстро, а Yahoo загружает котировки батчами.
- Если Yahoo временно не отвечает, сервис использует последнюю кэшированную цену.
- Если MEXC не отвечает, проблемный цикл пропускается, а предыдущий снимок остаётся доступным.
- Часть тикеров Yahoo может периодически отдавать batch-ошибки. В этом случае проблемный тикер просто пропускается до следующего цикла.
- Для графика используется Chart.js через CDN. Интернет всё равно нужен для Yahoo и MEXC, поэтому отдельная сборка фронтенда не требуется.
- Матчинг stock futures на MEXC сделан автоматически, но опирается на публичные поля контрактов и валидацию через Yahoo. При изменении правил MEXC фильтр можно скорректировать в `backend/matcher.py`.
- для публичного доступа лучше оставлять `Basic Auth` включённым: без неё сканер будет доступен любому, у кого есть ссылка.
