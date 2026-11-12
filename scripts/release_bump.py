# -*- coding: utf-8 -*-
"""Обновляет версию и заметки в scripts/release.ps1 перед публикацией."""
import io, os, re

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
p = 'scripts/release.ps1'
t = io.open(p, encoding='utf-8-sig').read()

notes = '''## Новое

- **Английский интерфейс** — расширение теперь двуязычное: язык выбирается автоматически по языку интерфейса VS Code (русский → русский, любой другой → английский). Переведены чат-панель, меню, диалоги, статус-бар и системные подсказки агента.

## English

- **English UI** — the extension is now bilingual: the language follows the VS Code display language (Russian → Russian, anything else → English). Chat panel, menus, dialogs, status bar and agent prompts are translated.
'''

t = re.sub(r'\$notes = @"\n.*?\n"@', '$notes = @"\n' + notes + '"@', t, count=1, flags=re.S)
t = t.replace("tag_name = 'v0.9.6'", "tag_name = 'v0.9.7'")
t = t.replace("name = 'v0.9.6 — агент не останавливается на полуслове'", "name = 'v0.9.7 — английский интерфейс'")
t = t.replace('kimi-code-0.9.6.vsix', 'kimi-code-0.9.7.vsix')
io.open(p, 'w', encoding='utf-8-sig', newline='').write(t)
print('release.ps1 обновлён до v0.9.7')
