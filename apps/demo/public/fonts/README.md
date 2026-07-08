# Bundled default fonts

These fonts ship with the demo so the browser terminal renders immediately —
no font picker required. Both are freely redistributable under the
**SIL Open Font License 1.1** (OFL). The full license text for each family is in
this folder and must travel with the font files.

| File | Family | Role | License |
| --- | --- | --- | --- |
| `Cousine-Regular.ttf` | Cousine | Monospace grid for Latin/ASCII cells | `Cousine-OFL.txt` |
| `Tajawal-Regular.ttf` | Tajawal | Arabic contextual joining (BiDi runs) | `Tajawal-OFL.txt` |

Source: the upstream Google Fonts OFL directory
(`github.com/google/fonts/tree/main/ofl/cousine` and `.../ofl/tajawal`).

The terminal loads `Cousine` for Latin/monospace runs and `Tajawal` for Arabic
runs via the font resolver, so the ASCII grid stays fixed-width while Arabic gets
correct letter joining. You can override either one with your own `.ttf`/`.otf`
using the pickers in the page header; overrides are read locally and never
uploaded.

No proprietary system fonts (Consolas, Arial, Traditional Arabic, …) are bundled
in this public repository.
