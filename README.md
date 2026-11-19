# Brainrot

**Track the fics that live rent free in your head.**

Brainrot is an Obsidian plugin for fanfic reading, made for AO3. Each fic is a plain Markdown note with properties. The plugin keeps the AO3 details, your own rating, every read and reread, and your podfic listens. At the end of the year, it writes "Brainrot Wrapped".

## Start here

1. Install the plugin and turn it on (see [Install](#install)).
2. Click the sparkles icon in the left ribbon. The library opens.
3. Click **Add fic**, paste an AO3 link, then click **Fetch**.
4. When you finish the fic, click **Mark read** and choose your rating.

## The library

- Search titles, authors, series, fandoms, relationships, characters and tags.
- Filter by status, your rating, fandom, relationship, AO3 rating, length and podfic.
- Sort by title, author, length, recently read or recently added.
- Click an author to see all of their fics.
- The list shows 100 fics at a time, so it stays fast with thousands of fics.

## Browse

**Browse** lists every fandom, relationship, character, author, tag, series, AO3 rating, your rating, length, library and year. Each entry shows the number of fics and the number you read. Click an entry to open the library with that filter.

## Your rating

Each fic note shows your rating levels as buttons. The defaults are **Evergreen**, **Favorites** and **Great**. Click a level to set it. Click it again to clear it. You can rename the levels in the settings.

## Reads and rereads

- **Start reading** sets the fic to "reading".
- **Mark read** adds a date to the `read` list. It also asks for your rating and a line for the reading log.
- On a fic you already read, the button says **Read again**. Each read keeps its own date.
- For an old read with no known date, type only the year.

The **Reading** tab shows the fics you read now, and all reads by year with the word count.

## Podfics

Add a podfic link or a narrator to a fic. The **Podfics** tab lists the podfics you have not heard yet and the ones you have. **Log a listen** records the date.

## Add a fic

**Add fic** opens a form. Paste the AO3 link and click **Fetch**. The plugin gets the title, author, fandoms, relationships, characters, tags, rating, words and summary from AO3.

If AO3 does not send the work, fill in the fields by hand. This happens with works that only logged-in users can see. A warning shows if the fic is already in your library.

## Import

**Import** reads a CSV file. It knows the columns from the Calibre export script, from a spreadsheet, and from a Brainrot export.

The import matches each row to a fic you already have, in this order:

1. The AO3 work ID.
2. The Calibre library name and Calibre ID.
3. The title and first author.

What an import changes:

- It refreshes the AO3 details: fandoms, tags, words, rating, series and link.
- It fills your status, rating, narrator and podfic link only where the fic has none.
- It adds read dates and never removes them.
- It fills the Notes and Summary sections only when they are empty.

The preview shows the new fics, the fics to update and the fics that did not change. Nothing changes until you click **Import**. Each import makes a log note in `Imports/`.

## From Calibre

`tools/brainrot_export.py` makes a CSV from a Calibre library:

```
python3 brainrot_export.py "/path/to/Calibre library" library.csv
```

- The script opens the library read-only.
- It reads fandoms, relationships, characters, tags and the summary from the AO3 header in each epub. It works with epubs from AO3 and from FanFicFare.
- It uses Calibre's word count and rating columns if the library has them.
- It needs Python 3 and nothing else.

## Year-end report

**Year-end report** writes "Brainrot Wrapped" for a finished year to `Exports/`. The command suggests last year. The report for the current year opens on January 1.

The report contains:

- A summary table: fics read, rereads, words read, the same words in novels, the average fic, and podfics.
- "Brainrot rankings": your top fandom, relationship, character, author, tag, rating and length.
- Highlights: the longest and shortest fic, your peak month, words per day, new authors, comfort rereads, and your top-rated reads.
- A month-by-month chart with fics and words.
- Each fic by month, with its fandom, ship, length, rating and the note from your reading log.
- Tables by fandom, by relationship, by tag, and the podfics.

The report also saves a `.json` file in the `year-in-reading/1` format. The [Year in Reading](https://github.com/jenniferlynparsons/year-in-reading) page reads this file.

## Show a list in any note

````markdown
```brainrot
show: reading
```
````

| Option | Result |
| --- | --- |
| `show: fic` | The bar for a fic note |
| `show: reading` | The fics you read now |
| `show: podfics` | Podfics you have not heard yet |
| `year: 2025` or `show: year` | The fics read in that year |
| `fandom: Good Omens` | All fics in a fandom |
| `relationship: Aziraphale/Crowley` | All fics with that relationship |
| `author: …`, `tag: …`, `tier: Evergreen` | All fics by an author, with a tag, or with your rating |

## Commands

| Command | Result |
| --- | --- |
| Open the library | Opens the main view |
| Add a fic | Opens the add form |
| Import fics from a CSV | Opens the import |
| Start reading this fic | Sets the open fic to "reading" |
| Mark this fic read | Records the date you finished |
| Log a podfic listen for this fic | Records a listen |
| Year-end report | Writes Brainrot Wrapped for a year |
| Export all fics as CSV | Makes a CSV that the import can read again |

The plugin sets no hotkeys.

## Settings

- **Open Brainrot when the vault opens:** on by default.
- **My rating levels:** Evergreen, Favorites, Great. Put the best one first.
- **Fics per page:** 100 by default.
- **Folders:** Fics, Import logs and Exports.

## Fic properties

| Property | Values |
| --- | --- |
| `title`, `author` | text. Co-creators are separated with a comma. |
| `fandoms`, `relationships`, `characters`, `tags` | lists |
| `rating` | an AO3 rating |
| `words` | a number |
| `chapters`, `series` | text |
| `complete` | true or false |
| `status` | `unread`, `reading`, `read` |
| `my_rating` | one of your rating levels |
| `read` | a list of dates or years |
| `podfic`, `narrator`, `podfic_link`, `listened` | the podfic, and the dates you listened |
| `link`, `work_id` | the AO3 link and work ID |
| `library`, `calibre_id`, `source`, `added` | where the fic came from |

## Network use

Brainrot connects to AO3 only when you click **Fetch** in the add form. It loads one work page. It has no accounts, no telemetry and no ads. It does not change files outside your vault.

## Install

**Manual install:**

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/brainrot/`.
3. In Obsidian, open **Settings → Community plugins** and turn on **Brainrot**.

**With BRAT:** add `jenniferlynparsons/brainrot` as a beta plugin.

The plugin works on desktop and mobile.

## License

MIT
