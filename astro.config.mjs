// @ts-check
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';
import remarkGfm from 'remark-gfm';

export default defineConfig({
  site: 'https://rezendesfelipe.com',
  markdown: {
    remarkPlugins: [remarkGfm],
  },
  integrations: [mdx(), sitemap()],
});
