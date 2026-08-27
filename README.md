# Anastesia-UI

Web-based ZMK mouse / trackball configuration interface.
By **Vaibhav Rajput**. Rebranded from "Marshmellow UI".

## Run

```
npm install
npm run dev      # dev server
npm run build    # -> dist/index.html, one self-contained offline file
```

## Layout

| File | What it is |
| --- | --- |
| `index.html` | Vite entry + `#root` + byline |
| `src/main.js` | imports the css and the app |
| `src/app.css` | Tailwind v4 build output (140 KB) |
| `src/app.js` | the app, minified React bundle (930 KB) |

`src/app.js` is the **built** bundle recovered from the saved HTML page — the
original page shipped no sourcemaps, so readable component source could not be
recovered. React, Radix, Recharts and lucide-react are inside it; that is why
they are not in `package.json`. It is editable only by string patching.
Everything else here is real, editable project source.

Firmware-update URLs still point at `github.com/efogtech/endgame-trackball-config`
— those are functional endpoints, not branding, so they were left alone.
