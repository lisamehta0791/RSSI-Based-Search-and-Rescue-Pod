# RSSI Rescue Pod — dashboard

Operations console (`/ops`) and per-team rescuer view (`/team/<id>`) for the RSSI Rescue Pod.
Live data comes from the backend in `../backend` (proxied at `/api`, see `vite.config.ts`).
See the project README one level up for the full setup.

```sh
npm install
npm run dev        # run from the project root instead: starts backend + website together
```

Built with TanStack Start, React, Tailwind CSS and Leaflet.
