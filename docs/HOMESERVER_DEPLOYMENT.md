# recommendMe: изолированное развёртывание на homeserver

## Основная установка 5.2 — 2026-10-27

**Рабочая библиотека теперь на homeserver**, в `$HOME/apps/recommendme/`: project `recommendme`, контейнер `recommendme-app`, образ `recommendme:5.2`. Постоянный путь внутри контейнера — `/app/data/movies.sqlite`. Каталоги data/backups имеют права 0700, SQLite и env-файлы — 0600, UID/GID 1000:1000. API-настройки переданы по SSH в приватный runtime.env, отдельно от образа и Git.

Основной адрес: **https://homeserver.tail25398e.ts.net:12443/**. На устройстве должен быть включён Tailscale; SSH-туннель компьютера не нужен. Docker публикует только `127.0.0.1:45151`. Новый Serve-маршрут доступен внутри tailnet, без Funnel. Существующие маршруты 443/8443/10443/11443 не изменены.

```sh
ssh -o ProxyCommand=none -o ProxyJump=none homeserver
cd "$HOME/apps/recommendme/source"
docker compose --env-file ../compose.env ps
docker compose --env-file ../compose.env run --rm --no-deps app node scripts/container-db.mjs check
curl --fail https://homeserver.tail25398e.ts.net:12443/api/health
docker compose --env-file ../compose.env logs --tail=40 app
```

Останавливать/перезапускать только эту установку: `docker compose --env-file ../compose.env stop app` / `restart app` из указанного каталога. Не запускать второй экземпляр с той же SQLite.

Перенесены 835 фильмов, 830 просмотров, 519 оценок, 311 просмотров без оценки, профиль v1 и 5 рекомендаций. Исходная схема уже 5, миграций не было. Hashes четырёх таблиц, схемы и JSON журнала совпали после переноса/restart/recreate. Сохранены request_id/result_id. Повтор сохранённого запроса на отдельной копии с `--network none` и без ключей дал 200/replayed, 0 вставок и неизменную SQLite/journal. OpenAI/TMDB API при переносе не вызывались.

После переключения владелец явно запустил ещё один подбор через UI. Теперь в основной базе 840 фильмов и 10 записей истории; просмотры, оценки и профиль не изменились. Первые 835 фильмов и 5 показов сохранены без изменений. Для текущего состояния создан дополнительный согласованный backup. Это пользовательское использование после переноса; агент не запускал новый платный подбор.

Локальная SQLite оставлена неизменной копией для восстановления, dev на 45143 остановлен. **Не вносить дальнейшие оценки в локальную копию:** синхронизации с сервером нет. Для разработки использовать отдельную тестовую БД и моки/пустые API-настройки. CSV и .env.local не изменены. Проверенный локальный backup и fingerprints сохранены в игнорируемом `data/backups/homeserver-transfer-*/`; исходный серверный snapshot — `backups/source-library-snapshot/`, отдельный backup с новым каноническим путём — `backups/snapshot-*/`.

Владелец подтвердил открытие на компьютере, в Brave и затем Safari на iPhone. Первоначальное зависание Safari исследовалось без изменения серверной защиты; причина не установлена. Автоматические серверные проверки подтвердили HTTPS, страницы, 13 assets, no-store и Origin. Полный пользовательский сценарий записи на физическом iPhone при переносе не выполнялся.

Тестовый `$HOME/apps/recommendme-51-test` сохранён для отката со своими данными и backup; его контейнер остановлен. После появления новых серверных оценок нельзя возвращаться к прежней локальной или тестовой базе с потерей изменений. Backup пока на том же диске; отдельный внешний носитель — дальнейшее решение.

### Backup и явная смена канонического пути

Для согласованной SQLite и journal перед backup остановить app и отдельные записывающие CLI:

```sh
docker compose --env-file ../compose.env stop app
docker compose --env-file ../compose.env run --rm --no-deps app node scripts/container-db.mjs backup --offline
docker compose --env-file ../compose.env up -d --no-build app
```

Обычный restore сохраняет запрет другого канонического пути и требует пустого назначения. Для осознанного переноса между хостами добавлен явный вариант:

```sh
node scripts/container-db.mjs restore /app/backups/source-library-snapshot --offline --relocate-from /exact/canonical/source/path/movies.sqlite
```

Значение --relocate-from должно точно совпасть с проверенным manifest. Меняется только хеш-каталог активного journal под новый DATABASE_PATH; содержимое JSON, request_id/result_id и lock сохраняются. Конфликт ключей останавливает операцию до копирования. Исходный snapshot не изменяется, блокировки не удаляются, миграции/API не запускаются. Восстановление поверх непустой или работающей базы запрещено. Обычные server snapshots уже имеют `/app/data/movies.sqlite` и не требуют этого флага.

## Архивная тестовая установка 5.1

Ниже сохранена процедура первоначального теста на синтетических данных. Она не является текущей production-конфигурацией; не путать каталоги и env-файлы.


Подфаза 5.1 использует только синтетическую библиотеку. Реальная SQLite, CSV и ключи с компьютера на сервер не переносятся. У приложения нет авторизации: порт публикуется **только на 127.0.0.1**, доступ — через SSH-туннель. LAN/WAN, reverse proxy и фаза 5.2 требуют отдельного решения.

## Проверенное окружение и расположение

Read-only диагностика 2026-10-27: Debian 13.4, amd64, 4 CPU, 7859 МиБ RAM; Docker 26.1.5+dfsg1, Compose 2.26.1-4. SSH-пользователь состоит в группе docker. До сборки свободно 8,5 ГБ. На сервере уже есть чужие приложения и Caddy; они не участвуют в этом Compose-проекте.

Отдельный каталог: `$HOME/apps/recommendme-51-test/`; Compose project: `recommendme-51-test`; контейнер: `recommendme-51-test-app`; проверенный свободный серверный порт: **45151**. Это тестовая установка, а не каталог реальной библиотеки.

Существующий локальный ProxyCommand был недоступен. Проверенный вход без изменения SSH-конфига:

```sh
ssh -o ProxyCommand=none -o ProxyJump=none homeserver
```

Используется уже установленный Tailscale; владелец подтвердил дополнительную SSH-проверку в браузере. Если обычный `ssh homeserver` уже работает, дополнительные опции не нужны. Приватные ключи не копируются.

Перед повторной установкой сначала проверить `uname -m`, `df -h`, `docker version`, `docker compose version`, `docker ps`, `ss -lnt` и права на каталог. Не перезаписывать существующий проект и не занимать чужой порт. Ресурсы и свободное место могут измениться.

## Образ и конфигурация

Multi-stage Dockerfile: Node 24 LTS, Debian/glibc, Linux `better-sqlite3`, production `next start`. Обычный runtime выбран ради предсказуемого включения файлов: миграции 001–005, native module, `.next` со шрифтами/статикой и команды обслуживания. Standalone не обязателен и здесь не используется. Dev dependencies и компиляторы остаются в build stage. TS-конфигурация Next компилируется в MJS при сборке, без TypeScript-компилятора в runtime.

`.dockerignore` допускает только необходимые исходники. Не отправляйте на сервер всю папку проекта вместе с локальными данными. Проверить состав архива/контекста перед передачей; включать только Dockerfile, .dockerignore, compose.yaml, package/lock, next/TS config, src, migrations и scripts/container-db.mjs. Никаких `.env`, SSH, CSV, SQLite и журналов.

На macOS архивировать с `COPYFILE_DISABLE=1 tar --no-xattrs ...`, чтобы не переносить служебные AppleDouble-файлы. Они также исключены из Docker context.

Каталог установки содержит `source/`, `data/`, `backups/`, приватные `runtime.env` и `compose.env`. На новой установке создать их от SSH-пользователя с `umask 077`, не от root. UID/GID должны соответствовать непривилегированному пользователю контейнера (в проверенной установке **1000:1000**). Каталоги 0700, файлы окружения 0600; bind mount не выполняет скрытый chown. Не монтировать Docker socket. На другом хосте явно проверить владельца и право записи; не исправлять это через chmod 777.

Пример **без настоящих ключей** для первого теста:

```sh
cd "$HOME/apps/recommendme-51-test"
umask 077
cat > runtime.env <<'EOF'
OPENAI_API_KEY=
OPENAI_MODEL=
TMDB_API_KEY=
EOF
cat > compose.env <<EOF
COMPOSE_PROJECT_NAME=recommendme-51-test
RECOMMENDME_DATA_DIR=$PWD/data
RECOMMENDME_BACKUP_DIR=$PWD/backups
APP_ENV_FILE=$PWD/runtime.env
APP_PORT=45151
APP_UID=1000
APP_GID=1000
RECOMMENDME_IMAGE=recommendme:phase51-test
EOF
chmod 600 runtime.env compose.env
```

Команды выше — только для **новых** файлов; не выполнять поверх настроенной установки. Compose требует явных каталогов и env-файла, не подставляет локальную `./data`. Внутри контейнера путь всегда `/app/data/movies.sqlite`. Переменная DATABASE_PATH из runtime.env его не переопределяет. Каталог `.next/cache` — отдельный временный tmpfs; SQLite и журнал в tmpfs не находятся.

```sh
cd "$HOME/apps/recommendme-51-test/source"
docker compose --env-file ../compose.env config --quiet
DOCKER_BUILDKIT=1 docker build --memory=2g --cpu-period=100000 --cpu-quota=150000 -t recommendme:phase51-test .
```

Не выводить обычный `docker compose config`, `docker inspect ...Config.Env` или весь env в отчёт. Ключей нет в build args, Dockerfile и образе. На тесте API-настройки пустые.

## Инициализация и запуск

Команда ниже создаёт/мигрирует **только явно выбранную тестовую** SQLite. Выполнять при остановленном приложении. Для существующей поддерживаемой базы сначала создаётся проверенный backup; неизвестная новая схема отклоняется.

```sh
docker compose --env-file ../compose.env run --rm --no-deps app node scripts/container-db.mjs init --offline
docker compose --env-file ../compose.env run --rm --no-deps app node scripts/container-db.mjs check
docker compose --env-file ../compose.env up -d --no-build app
docker compose --env-file ../compose.env ps
curl --fail http://127.0.0.1:45151/api/health
docker compose --env-file ../compose.env logs --tail=40 app
```

На старте нет миграций, импорта, генерации профиля или рекомендаций. Health открывает SQLite только для чтения; отсутствующая база возвращает 503 и не создаётся. Compose healthcheck вызывает этот маршрут внутри контейнера. Native SQLite и все пять SQL-файлов проверяются командой init/check.

Для воспроизведения синтетического наполнения на компьютере с dev dependencies есть `npx tsx scripts/fixtures/phase5-prepare.ts /absolute/new/test-folder/movies.sqlite`. Путь должен быть новым. Скрипт создаёт тестовые 0/NULL, профиль, две тестовые рекомендации и журнал для канонического **контейнерного** пути; реальных API не вызывает. Это не импорт Letterboxd и не production seed. Переносить только этот синтетический каталог в отдельное остановленное тестовое хранилище; не подменять существующую пользовательскую базу.

## Туннель и обычные операции

Проверить свободный локальный порт 45151, затем в отдельном терминале компьютера:

```sh
ssh -o ProxyCommand=none -o ProxyJump=none -N -o ExitOnForwardFailure=yes -L 127.0.0.1:45151:127.0.0.1:45151 homeserver
```

Открыть `http://127.0.0.1:45151`. Origin сверяется с фактическим Host; чужой/null Origin остаётся запрещённым. Не добавлять CORS и не ослаблять CSRF ради туннеля. Публикация Compose привязана к loopback; текущая установка не предоставляет прямой доступ с телефона по LAN.

Все команды из `source/`, только для этого проекта:

```sh
docker compose --env-file ../compose.env restart app
docker compose --env-file ../compose.env up -d --no-build --force-recreate app
docker compose --env-file ../compose.env stop app
docker compose --env-file ../compose.env ps
```

Обновление: остановить app → backup → проверить/обновить исходники → собрать образ → явно проверить/применить миграции, если нужны → up → health/библиотека/история. Простой rebuild сам миграции не выполняет. Bind data и backups не удалять. Не использовать `system prune`, `volume prune`, `down -v` и команды чужих проектов. Контейнер имеет фиксированное имя проекта; масштабирование не поддерживается. Не запускать второй проект/CLI, работающий с той же SQLite, параллельно операции обслуживания.

SIGTERM передаётся через init непосредственно Node. Next закрывает HTTP и ожидает текущие запросы; `stop_grace_period=16m` даёт время существующему 15-минутному дедлайну конвейера. При принудительном завершении платная операция не перезапускается автоматически.

## Полный backup и проверенное восстановление

Backup включает SQLite **через backup API**, схему, счётчики четырёх таблиц, SHA-256, `.recommendation-runs/`, recommendation/taste lock. Для согласованности SQLite и файлов журнала приложение и самостоятельные записывающие CLI должны быть остановлены. `--offline` — явное подтверждение этого условия, а не автоматическая остановка процессов.

```sh
docker compose --env-file ../compose.env stop app
docker compose --env-file ../compose.env run --rm --no-deps app node scripts/container-db.mjs backup --offline
# Подставить имя snapshot-... из предыдущего вывода:
docker compose --env-file ../compose.env run --rm --no-deps app node scripts/container-db.mjs verify /app/backups/snapshot-...
docker compose --env-file ../compose.env up -d --no-build app
```

BACKUP_DIR обязателен и находится вне data. Проверенная установка использует отдельный bind-каталог `backups/` на том же диске; это не защита от отказа всего диска. Для реальных данных отдельно копировать проверенные snapshots на другой носитель. Snapshot содержит приватные данные, не публиковать его.

Восстановление проверяется в **другой пустой хостовый каталог**, смонтированный по тому же `/app/data`. Ничего не перезаписывать. Остановить app и проверить отсутствие других writers. Создать отдельный restore.env копированием compose.env с заменой только RECOMMENDME_DATA_DIR на новый пустой каталог (те же UID/GID и canonical DATABASE_PATH).

```sh
docker compose --env-file ../restore.env run --rm --no-deps app node scripts/container-db.mjs restore /app/backups/snapshot-... --offline
docker compose --env-file ../restore.env run --rm --no-deps app node scripts/container-db.mjs check
docker compose --env-file ../restore.env up -d --no-build --force-recreate app
```

`verify` проверяет каждый файл, integrity/FK, версию и числа записей. Restore отказывается работать с непустым каталогом, неизвестной схемой, checksum mismatch, symlink и другим каноническим путём без явного --relocate-from. Миграций и API-вызовов при restore нет. Старый тестовый data-каталог сохраняется до приёмки новой копии. После проверки остановить app и явно вернуть исходный compose.env. Никогда не восстанавливать учебный snapshot поверх реальной библиотеки.

## Аварийный lock и durable journal

База, `.recommendation-runs/` и `movies.sqlite.recommendations.lock` находятся в одном постоянном `/app/data`. Журнал привязан к SHA-256 **канонического пути**, а не к inode контейнера. Перезапуск/recreate не меняет `/app/data/movies.sqlite`; request_id и подготовленный результат сохраняются. Открытие страницы и restart не вызывают AI.

При аварии старый lock сохраняется. PID в другом контейнере может быть повторно использован; одного `kill -0` недостаточно. Проверено, что lock с совпавшим PID, но временем до старта нынешнего процесса, показывается как interrupted, а не running. Блокировка всё равно остаётся и запрещает новый запуск.

Безопасное восстановление: остановить **только app**, проверить `docker compose ps` и отсутствие самостоятельных writers с этой базой, создать полный backup вместе с lock и журналом. Владелец проверяет PID/время владельца и статус request_id. Только после доказательства, что прежний процесс завершён, вручную **переместить** конкретный stale lock в приватный архив вне data; не удалять журнал и не автоматизировать очистку. После запуска GET покажет interrupted/save_failed. Подготовленный результат можно сохранить через существующий save-only, без оплаты; попытку без подготовленного результата не считать завершённой и не повторять автоматически. Сохранённые request_id возвращают SQL-результат без нового запроса.

## Первоначальный план переноса — выполнен в 5.2

1. Определить фактический DATABASE_PATH через серверное окружение, не печатая ключи. Проверить актуальные counts, схему, integrity/FK; исторические 830/519/311 не использовать как приказ перезаписи.
2. Остановить локальные writers, выполнить SQLite backup API и согласованную копию журнала/lock; SHA-256, закрытый доступ, отдельная неизменная исходная копия. Не копировать активный .sqlite обычным cp без WAL/backup.
3. Через SCP/SFTP передать **backup** в новый приватный каталог сервера; сравнить checksum. Проверить, что назначения ещё нет. Отдельно защитить уже существующую серверную базу, если она появилась; никаких перезаписей.
4. Канонический путь меняется с macOS на `/app/data/movies.sqlite`: журнал использует хеш пути. До запуска составить явное соответствие старого и нового ключа каталога, сохранить оригинал, перенести согласованный журнал/lock и проверить replay request_id. Обычный restore отклоняет такую смену пути; в 5.2 добавлен явный --relocate-from с проверкой manifest и конфликта ключей. В 5.1 реальный журнал не переносился.
5. Оставить отдельный pre-migration backup. Проверить версию и **явно** применить существующие миграции 3→5 только при необходимости. Проверить все четыре таблицы/профиль/историю, исходные поля, 0/NULL и integrity/FK до старта.
6. Подключить приватное production-окружение отдельно от образа, поднять один app на loopback, проверить туннель/Origin/библиотеку/профиль/историю без AI. Не переимпортировать CSV и не пересоздавать профиль.
7. Доступ с телефона по LAN — отдельная проверка частного интерфейса/firewall/маршрутов и явное разрешение владельца. Никакого публичного DNS, forwarding, Cloudflare Tunnel или WAN в рамках 5.1.
