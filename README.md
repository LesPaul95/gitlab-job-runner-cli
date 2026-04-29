# evo-gitlab-cli

CLI на Node.js для раскатки нужной ветки на стенд через GitLab job.

Логика:

- пробует найти указанную ветку (например `Feature-1`);
- если ветка есть, использует существующие pipeline этой ветки;
- если ветки нет, использует `stable` (или значение `DEFAULT_BRANCH`);
- перед запуском сравнивает `HEAD` целевой ветки с последним успешно задеплоенным коммитом для выбранной job;
- если коммит уже развернут, пайплайн не запускается;
- в найденном pipeline ищет job (по умолчанию `to_dev1`) и запускает ее.

## Установка

```bash
npm install
cp .env.example .env
```

Заполни `.env`:

```dotenv
GITLAB_API_BASE=https://gitlab.com/api/v4
GITLAB_TOKEN=your_personal_access_token
DEFAULT_BRANCH=stable
# PROJECTS_FILE=projects.json
```

Заполни `projects.json`:

```json
[
  {
    "name": "app1",
    "projectPath": "group/app1"
  }
]
```

`projectPath` можно указать как:

- `group/subgroup/project`
- `https://gitlab.com/group/subgroup/project`

## Использование

Запуск для всех проектов из `projects.json`:

```bash
npx gitlab-deploy deploy --branch Feature-1 --job to_dev1
```

Запуск только для конкретного проекта:

```bash
npx gitlab-deploy deploy --branch Feature-1 --job to_dev1 --project app1
```

## Требования

- Node.js 18+
- GitLab Personal Access Token с правами API
