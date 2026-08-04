## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)


## Git Backup Policy

This repository is mirrored to a self-hosted backup server (frodo). After every push to the primary remote, also push to the backup remote to keep the mirror in sync.

### Remotes
| Name | URL | Role |
|------|-----|------|
| `origin` | git@github.com:ashwin-cogspark/drypod.in.git | Primary remote (GitHub / upstream, SSH) |
| `backup` | frodo:~/git-repos/drypod.in.git | Self-hosted mirror (frodo) |

### Push Protocol
Always push to both remotes after committing:

```bash
# Push to primary remote
git push origin <branch>

# Then push to backup mirror
git push backup <branch>
```

### Convenience Alias
Already configured in this repo (`.git/config`) so `git pushall` pushes to both:

```bash
# Usage: git pushall
```

To (re)create it manually:

```bash
git config alias.pushall '!git push origin && git push backup'
```

Or add to your shell profile (`~/.bashrc`):

```bash
alias gpush='git push origin && git push backup'
```

