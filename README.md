# Iatron website

A React/Vite guided pathway viewer with all content packaged locally. There is no application server.

```powershell
npm.cmd install
npm.cmd run dev
```

- `build:data`: package existing generated flows and canonical PNGs for both apps.
- `rebuild:data`: optionally rebuild the corpus using Python and the neighboring source project, then package it.
- `build`: package data, build the static website, and generate the complete offline cache.
- `preview`: serve the production build on localhost.
- `test`: build and run corpus, routing, and offline packaging tests.
- `check`: check TypeScript for the website and Vite configuration.

The website imports the shared library from `../mobile/src/data/library.json` and bundles the same
97 illustrations as the native app. Keep the mobile and website directories together when building.
The output in `dist/` is standalone and can be served by any static server.

Production installs a service worker that precaches every build file. Open once online and wait for
`Ready for offline use` before disconnecting. Offline reloads, all procedures, and all illustrations
then use the browser cache. HTTPS or localhost is required; the Vite dev server does not install it.
Browser storage limits apply, and clearing site data removes the cached app.

Generated development reports stay in `generated/development/`; they are not copied into the public build.
The full conversion workflow, source inputs, validation, and known corpus boundaries are described
in the [root guide](../README.md).
