# Security Policy

## Supported versions

napari-js is pre-1.0. Only the latest published `0.x` release receives fixes.

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security Advisories —
<https://github.com/TheJacksonLaboratory/napari-js/security/advisories/new> — rather than opening a
public issue. We'll acknowledge the report and coordinate a fix and disclosure.

## Scope

napari-js is a client-side rendering library. It has no network, authentication, or
filesystem surface of its own: all data fetching is delegated to the host application through
the `TextureSource` / `fetchTile` interfaces. Treat data fetched by your host adapter (e.g.
server tiles) according to your own application's trust model.
