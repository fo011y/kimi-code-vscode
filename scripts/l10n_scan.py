# -*- coding: utf-8 -*-
"""Выгружает строки с кириллицей из src/*.ts (кроме i18n.ts) для построения таблицы замен."""
import io, re, sys, os

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
files = ['src/config.ts', 'src/auth.ts', 'src/agent.ts', 'src/extension.ts', 'src/chatPanel.ts']
pat = re.compile(r'[а-яА-ЯёЁ]')
for f in files:
    print('===== ' + f + ' =====')
    with io.open(f, encoding='utf-8') as fh:
        for i, line in enumerate(fh, 1):
            s = line.strip()
            if not pat.search(line):
                continue
            if s.startswith('//') or s.startswith('*') or s.startswith('/*'):
                continue
            print('%d\t%s' % (i, line.rstrip()))
