# drypod.in

Personal blog. Live at [drypod.in](https://drypod.in).

## Stack

- **Astro** 7 — static site generator, Markdown posts
- **Cloudflare Workers** — hosting (via GitHub integration on push to `main`)
- **Cloudflare Web Analytics** — privacy-friendly, cookieless, auto-injected via orange-cloud proxy
- Zero ongoing cost (domain renewal only)

## Add a post

Drop a Markdown file in `src/content/blog/` with this frontmatter:

```yaml
---
title: 'Post title'
description: 'One-line description for SEO/RSS'
pubDate: YYYY-MM-DD
tags: ['tag1', 'tag2']
---
```

Filename becomes the URL slug (e.g. `hello-world.md` → `/blog/hello-world/`).

## Local dev

```sh
npm install
npm run dev        # http://localhost:4321
```

## Deploy

Push to `main`. Cloudflare rebuilds and deploys via Workers Builds (~60s).

Manual one-off deploy (if needed):

```sh
npm run build
npx wrangler deploy
```

`wrangler.jsonc` at repo root tells Wrangler to serve `./dist` as static assets for the `drypod-in` Worker.

## Project structure

```
src/
├── assets/        # fonts, images
├── components/    # Header, Footer, BaseHead, etc.
├── content/blog/  # posts (one .md per post)
├── layouts/       # BlogPost.astro (post page wrapper)
├── pages/         # index.astro (home), about.astro, blog/index.astro, rss.xml.js
├── styles/        # global.css
└── consts.ts      # SITE_TITLE, SITE_DESCRIPTION
```

## Notes

- **Cloudflare Pages vs Workers**: Cloudflare unified Pages into Workers in 2026. This project deploys as a Worker with static assets, not a legacy Pages project. The `wrangler.jsonc` with `assets.directory` is what makes Wrangler treat it as a static site.
- **Comments**: not wired up. Revisit (Disqus vs self-hosted Remark42) when real traffic justifies it.
- **Newsletter**: not planned. Blog-only.
- **Monetization**: possible later (AdSense, Amazon Associates India, AI-tool affiliates) without re-platforming.

## Credit

Built on the [Astro Blog starter kit](https://astro.build/themes/details/blog/), itself based on [Bear Blog](https://github.com/HermanMartinus/bearblog/).
