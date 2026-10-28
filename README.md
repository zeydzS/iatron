# Iatron website

A React/Vite guided pathway viewer with all content packaged locally. There is no application server.

```powershell
npm.cmd install
npm.cmd run dev
```

- `build:data`: refresh both apps' packaged content from the neighboring source project.
- `rebuild:data`: optionally rebuild the corpus using Python and the neighboring source project, then package it.
- `verify:content`: validate the packaged catalog, flows, and all illustration hashes.
- `build`: validate the committed content, build the static website, and generate the complete offline cache.
- `preview`: serve the production build on localhost.
- `test`: build and run corpus, routing, and offline packaging tests.
- `check`: check TypeScript for the website and Vite configuration.

The website contains its own generated library in `web/src/data/library.json` and the same
97 illustrations as the native app in `web/src/assets/pathways/`. These files must be committed.
Normal builds and development need only this repository. After changing the source content,
run `npm.cmd run build:data` in the complete local workspace, then commit the refreshed library,
image registry, and PNGs. Source regeneration and the full cross-app test suite still require
the neighboring mobile, extraction, and original Visio directories.
The output in `dist/` is standalone and can be served by any static server.

For Vercel, import this website repository with Root Directory left at the repository root.
The included `vercel.json` selects Vite, `npm run build`, and the `dist` output directory.
No Python, mobile checkout, or Visio extraction files are needed during deployment.

Production installs a service worker that precaches every build file. Open once online and wait for
`Ready for offline use` before disconnecting. Offline reloads, all procedures, and all illustrations
then use the browser cache. HTTPS or localhost is required; the Vite dev server does not install it.
Browser storage limits apply, and clearing site data removes the cached app.

Generated development reports stay in `generated/development/`; they are not copied into the public build.
The full conversion workflow, source inputs, validation, and known corpus boundaries are described
in the [root guide](../README.md).
