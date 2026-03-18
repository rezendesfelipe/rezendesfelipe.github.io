# Copilot Instructions

## Project Overview

This is **Felipe Rezende's personal website**, built with <a href="https://astro.build/">Astro</a>. It is a static site deployed to GitHub Pages at <a href="https://rezendesfelipe.github.io">rezendesfelipe.github.io</a>. The site includes a blog, a projects showcase, and a certifications section, and supports bilingual content (Portuguese and English).

## Tech Stack

- **Framework**: <a href="https://astro.build/">Astro</a> v6
- **Content**: Markdown (`.md`) and MDX (`.mdx`) via Astro Content Collections
- **Language**: TypeScript
- **Styling**: Plain CSS (scoped in `.astro` component `<style>` blocks)
- **Fonts**: <a href="https://vercel.com/font">Geist</a> (via the `geist` npm package)
- **Node.js**: &gt;=22.12.0

## Local Development

```sh
# Install dependencies
npm install

# Start the local dev server (http://localhost:4321)
npm run dev

# Build for production (output goes to ./dist/)
npm run build

# Preview the production build locally
npm run preview
```

There is no dedicated test suite. Verify changes by running `npm run build` (TypeScript type-checking and Astro compilation) and `npm run dev` for visual inspection.

## Project Structure

```
.github/
  workflows/deploy.yml   # CI/CD: builds &amp; deploys to GitHub Pages on push to main
  workflows/deploy.yml   # CI/CD: builds & deploys to GitHub Pages on push to main
public/                  # Static assets served at the root (images, fonts, etc.)
src/
  assets/                # Processed assets (e.g. images imported in components)
  components/            # Reusable Astro components (Header, Footer, Card, etc.)
  content/
    blog/                # Blog posts as .md/.mdx files (supports pt/en via `lang` frontmatter)
    certifications/      # Certification entries as .md files
    projects/            # Project entries as .md files
  data/                  # Static data files (e.g. JSON)
  layouts/
    BlogPost.astro       # Layout for individual blog post pages
  pages/                 # File-based routing; .astro, .md, and .xml.js files become routes
    index.astro          # Home page
    about.astro          # About page
    blog/                # Blog listing and post pages
    en/                  # English-language versions of pages
    rss.xml.js           # RSS feed
  styles/                # Global CSS files
  consts.ts              # Site-wide constants (SITE_TITLE, SITE_DESCRIPTION)
  content.config.ts      # Astro Content Collections schema definitions
astro.config.mjs         # Astro configuration (site URL, integrations)
tsconfig.json            # TypeScript configuration
```

## Content Collections

Defined in `src/content.config.ts`:

| Collection       | Location                     | Key frontmatter fields                                                  |
|-----------------|------------------------------|-------------------------------------------------------------------------|
| `blog`          | `src/content/blog/`          | `title`, `description`, `pubDate`, `updatedDate?`, `heroImage?`, `lang` (`pt`\|`en`), `tags` |
| `projects`      | `src/content/projects/`      | `title`, `description`, `url`, `repo?`, `tags`, `featured`, `order?`   |
| `certifications`| `src/content/certifications/`| `lang`, `title`, `issuer`, `issuedAt?`, `url?`, `order?`               |

## Conventions

- **Bilingual support**: Blog posts and certifications have a `lang` field (`'pt'` or `'en'`). Pages under `src/pages/en/` are English versions; the default language is Portuguese.
- **Component style**: UI is built with `.astro` components. Styles are scoped inside `<style>` blocks within each component.
- **No UI framework**: There is no React, Vue, or Svelte. Keep new UI as `.astro` components unless a strong reason requires a framework.
- **TypeScript**: All non-content files should use TypeScript. Frontmatter schemas are defined with Zod in `content.config.ts`.
- **Static output**: The site is fully static (`output: 'static'` is the Astro default). Avoid server-side rendering features.
- **Constants**: Site-level metadata lives in `src/consts.ts`; import from there rather than hardcoding strings.

## Deployment

Pushes to the `main` branch automatically trigger the `deploy.yml` workflow, which builds the site and deploys it to GitHub Pages. No manual deployment steps are needed.
