#!/usr/bin/env python3
"""Export a Calibre fanfic library to a CSV that Brainrot imports.

Usage:
    python3 brainrot_export.py "<path to Calibre library>" output.csv

The library is opened read-only. Nothing in Calibre changes.

Columns: Title, Author, Fandoms, Relationships, Characters, Tags, Rating, Words,
Chapters, Series, Status, Link, AO3 Work ID, Summary, Added, Calibre ID, Library,
Source, My Rating.

Fandoms, relationships, characters and tags come from the AO3 header that AO3
and FanFicFare put at the start of each epub. Words, rating and status use
Calibre's values when the epub does not have them.
"""
import csv
import html
import os
import re
import sqlite3
import sys
import zipfile

LABELS = [
    'Rating', 'Archive Warnings?', 'Warnings?', 'Category', 'Categories', 'Fandoms?', 'Relationships?', 'Ships?',
    'Characters?', 'Additional Tags', 'Freeform Tags', 'Freeforms?', 'Genre', 'Language', 'Series', 'Collections?',
    'Stats', 'Published', 'Updated', 'Completed', 'Words', 'Chapters', 'Comments', 'Kudos', 'Bookmarks', 'Hits',
    'Summary', 'Notes', 'Status', 'Site', 'Packaged', 'Story URL', 'Author', 'Title',
]
LABEL_RE = re.compile(r'(?:(?<=\s)|^)(' + '|'.join(LABELS) + r'):\s', re.I)
RATINGS = ['Explicit', 'Mature', 'Teen And Up Audiences', 'General Audiences', 'Not Rated']  # most restrictive first
POSTED = re.compile(rb'Posted originally on the <a[^>]*>Archive of Our Own</a> at <a href="https?://archiveofourown\.org/works/(\d+)')
WORK = re.compile(rb'archiveofourown\.org/works/(\d+)')


def text_of(b):
    s = b.decode('utf8', 'ignore')
    s = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', s, flags=re.S | re.I)
    s = re.sub(r'<br\s*/?>|</p>|</dd>|</dt>|</li>|</div>', '\n', s, flags=re.I)
    s = html.unescape(re.sub(r'<[^>]+>', ' ', s))
    return re.sub(r'[ \t\xa0]+', ' ', s)


def epub_files(lib, path):
    folder = os.path.join(lib, path)
    for f in sorted(os.listdir(folder)):
        if f.endswith('.epub'):
            try:
                yield zipfile.ZipFile(os.path.join(folder, f))
            except Exception:
                pass
            return


def header_text(z):
    """Text of the title/preface pages, where AO3 and FanFicFare list the tags."""
    out = []
    names = [n for n in z.namelist() if n.endswith(('html', 'htm', 'xhtml'))]
    first = [n for n in names if re.search(r'(title|preface|titlepage|start|split_000|info)', n, re.I)] or names[:2]
    for n in first[:3]:
        out.append(text_of(z.read(n)))
    return '\n'.join(out)


def parse_header(t):
    """{label: value} from 'Fandom: X\nRelationship: Y\n...' text."""
    found = {}
    marks = list(LABEL_RE.finditer(t))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else min(len(t), m.end() + 4000)
        key = m.group(1).lower().rstrip('s')
        if key in ('relationship', 'ship'):
            key = 'relationship'
        if key in ('categorie',):
            key = 'category'
        val = t[m.end():end].strip()
        if key not in found and val:
            found[key] = val
    return found


def split_tags(v):
    if not v:
        return []
    v = re.split(r'\n\s*\n', v.strip())[0]
    parts = [p.strip(' \n,') for p in re.split(r',\s*|\n', v)]
    return [p for p in parts if p and len(p) < 200]


AO3_CATEGORIES = {'F/F', 'F/M', 'M/M', 'Gen', 'Multi', 'Other'}


def fandoms_of(head):
    """AO3 epubs say Fandom. FanFicFare puts fandoms under Category, and AO3 categories (M/M) under Category too."""
    if head.get('fandom'):
        return head['fandom']
    cats = split_tags(head.get('category', ''))
    return ', '.join(x for x in cats if x not in AO3_CATEGORIES)


def one(c, q, *a):
    r = c.execute(q, a).fetchone()
    return r[0] if r else None


def many(c, q, *a):
    return [r[0] for r in c.execute(q, a)]


def custom_value(c, label, bid):
    """Value of a Calibre custom column by its label, like 'words' or 'myrating'."""
    row = c.execute('select id, is_multiple from custom_columns where label=?', (label,)).fetchone()
    if not row:
        return ''
    cid, multiple = row
    try:
        vals = many(c, f'select v.value from custom_column_{cid} v join books_custom_column_{cid}_link l on l.value=v.id where l.book=?', bid)
    except sqlite3.OperationalError:
        vals = many(c, f'select value from custom_column_{cid} where book=?', bid)
    return ', '.join(str(v) for v in vals if v is not None)


def main(lib, out_path):
    lib_name = os.path.basename(os.path.normpath(lib))
    c = sqlite3.connect(f'file:{os.path.join(lib, "metadata.db")}?mode=ro', uri=True)
    labels = set(many(c, 'select label from custom_columns'))
    words_col = next((l for l in ('words', 'wordcount', 'word_count') if l in labels), None)
    rating_col = next((l for l in ('myrating', 'my_rating', 'rating') if l in labels), None)
    rows = []
    for bid, title, path, ts, sidx in c.execute('select id,title,path,timestamp,series_index from books order by id').fetchall():
        authors = ' & '.join(a.replace('|', ',') for a in many(c, 'select a.name from authors a join books_authors_link l on l.author=a.id where l.book=? order by l.id', bid))
        tags = set(many(c, 'select t.name from tags t join books_tags_link l on l.tag=t.id where l.book=?', bid))
        url = one(c, "select val from identifiers where book=? and type='url'", bid) or ''
        head, summary = {}, one(c, 'select text from comments where book=?', bid) or ''
        for z in epub_files(lib, path):
            ht = header_text(z)
            head = parse_header(ht)
            if not head.get('summary'):
                m = re.search(r'\bSummary\s*\n+\s*(.+?)(?:\n\s*\n|\bNotes\b|$)', ht, re.S)
                if m:
                    head['summary'] = m.group(1).split('Posted originally')[0].strip()
            if not url:
                for n in z.namelist():
                    if n.endswith(('html', 'htm', 'xhtml', 'opf')):
                        b = z.read(n)
                        m = POSTED.search(b) or WORK.search(b)
                        if m:
                            url = 'https://archiveofourown.org/works/' + m.group(1).decode()
                            break
        url = re.sub(r'^http://', 'https://', url)
        work = re.search(r'archiveofourown\.org/works/(\d+)', url)
        rating = next((r for r in RATINGS if r in tags or r == (head.get('rating') or '').split(',')[0].strip()), '')
        status = 'Complete' if 'Completed' in tags else ('In progress' if 'In-Progress' in tags else '')
        m = re.search(r'(\d+\s*/\s*(?:\d+|\?))', head.get('chapter', '') + ' ' + head.get('stat', ''))
        chapters = re.sub(r'\s+', '', m.group(1)) if m else ''
        if not status and chapters:
            a, b = [x.strip() for x in chapters.split('/')]
            status = 'Complete' if a == b else 'In progress'
        words = custom_value(c, words_col, bid) if words_col else ''
        if not words:
            m = re.search(r'([\d,]+)', head.get('word', ''))
            words = m.group(1).replace(',', '') if m else ''
        series = one(c, 'select s.name from series s join books_series_link l on l.series=s.id where l.book=?', bid) or ''
        publisher = (one(c, 'select p.name from publishers p join books_publishers_link l on l.publisher=p.id where l.book=?', bid) or '').lower()
        source = 'AO3' if work or 'archiveofourown' in publisher or 'FanFiction' in tags else 'Other'
        summary = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', summary))).strip() or re.split(r'\n\s*\n', head.get('summary', '').strip())[0][:2000]
        rows.append({
            'Title': title, 'Author': authors,
            'Fandoms': ', '.join(split_tags(fandoms_of(head))),
            'Relationships': ', '.join(split_tags(head.get('relationship', ''))),
            'Characters': ', '.join(split_tags(head.get('character', ''))),
            'Tags': ', '.join(split_tags(head.get('additional tag') or head.get('freeform tag') or head.get('freeform') or head.get('genre', ''))),
            'Rating': rating, 'Words': words, 'Chapters': chapters,
            'Series': f'{series} #{sidx:g}' if series else '', 'Status': status, 'Link': url,
            'AO3 Work ID': work.group(1) if work else '', 'Summary': summary, 'Added': (ts or '')[:10],
            'Calibre ID': bid, 'Library': lib_name, 'Source': source,
            'My Rating': custom_value(c, rating_col, bid) if rating_col else '',
        })
    if not rows:
        sys.exit('No books found in that library.')
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    with_fandom = sum(1 for r in rows if r['Fandoms'])
    print(f'{len(rows)} fics -> {out_path} ({with_fandom} with fandom tags)')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
