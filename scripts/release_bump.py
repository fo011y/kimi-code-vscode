# -*- coding: utf-8 -*-
"""
Подготовка релиза: читает версию из package.json и заметки из scripts/release_notes.md
(секции ## TITLE / ## RU / ## EN), затем:
  1. Обновляет scripts/release.ps1 (тег, имя, заметки, имя vsix).
  2. Обновляет раздел «## 🆕 Новое в X.Y.Z» в README.md (рус.) и README.en.md (англ.).
После этого запустите: powershell -File scripts/release.ps1
"""
import io, json, os, re, sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ver = json.load(io.open('package.json', encoding='utf-8'))['version']
tag = 'v' + ver

# --- разбираем заметки ---
notes_raw = io.open('scripts/release_notes.md', encoding='utf-8').read()
def section(name, nxt):
    m = re.search(r'## %s\s*\n(.*?)\n(?=## %s)' % (name, nxt), notes_raw, re.S)
    if not m:
        m = re.search(r'## %s\s*\n(.*)$' % name, notes_raw, re.S)
    return m.group(1).strip()

title = section('TITLE', 'RU')
ru = section('RU', 'EN')
en = section('EN', None)
if not (title and ru and en):
    print('ОШИБКА: в scripts/release_notes.md нужны секции ## TITLE, ## RU, ## EN')
    sys.exit(1)

# --- 1. release.ps1 ---
p = 'scripts/release.ps1'
t = io.open(p, encoding='utf-8-sig').read()
body_notes = ru + '\n\n## English\n\n' + en + '\n'
t = re.sub(r'\$notes = @"\n.*?\n"@', '$notes = @"\n' + body_notes + '"@', t, count=1, flags=re.S)
t = re.sub(r"tag_name = 'v[0-9.]+'", "tag_name = '%s'" % tag, t)
t = re.sub(r"(?<!tag_)name = '[^']*'", "name = '%s'" % title, t)
t = re.sub(r'kimi-code-[0-9.]+\.vsix', 'kimi-code-%s.vsix' % ver, t)
io.open(p, 'w', encoding='utf-8-sig', newline='').write(t)

# --- 2. README.md / README.en.md ---
def update_readme(path, header, body):
    t = io.open(path, encoding='utf-8').read()
    new_section = '%s\n\n%s\n' % (header, body)
    t2, n = re.subn(r'## 🆕 [^\n]*\n.*?(?=\n## )', new_section, t, count=1, flags=re.S)
    if n != 1:
        print('ОШИБКА: не нашёл раздел 🆕 в ' + path)
        sys.exit(1)
    io.open(path, 'w', encoding='utf-8', newline='').write(t2)

update_readme('README.md', '## 🆕 Новое в %s' % ver, ru)
update_readme('README.en.md', '## 🆕 What\u2019s new in %s' % ver, en)

# --- 3. строки в таблицы истории версий ---
summary_en = section('SUMMARY_EN', None)
# заголовок вида "v0.9.7 — английский интерфейс" → "Английский интерфейс"
ru_short = re.sub(r'^v[0-9.]+\s*[—-]\s*', '', title)
ru_short = ru_short[0].upper() + ru_short[1:] if ru_short else title

def add_history_row(path, header_re, summary):
    t = io.open(path, encoding='utf-8').read()
    if ('/tag/v%s)' % ver) in t:
        return  # строка уже есть
    row = '| [%s](https://github.com/fo011y/kimi-code-vscode/releases/tag/v%s) | %s |\n' % (ver, ver, summary)
    t2, n = re.subn(header_re, lambda m: m.group(0) + row, t, count=1)
    if n == 1:
        io.open(path, 'w', encoding='utf-8', newline='').write(t2)
    else:
        print('ПРЕДУПРЕЖДЕНИЕ: таблица истории не найдена в ' + path)

add_history_row('README.md', r'\| Версия \| Что нового \|\n\|---\|---\|\n', ru_short)
if summary_en:
    add_history_row('README.en.md', r'\| Version \| Highlights \|\n\|---\|---\|\n', summary_en)

print('Подготовлено: %s (%s)' % (tag, title))
print('Теперь: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1')
