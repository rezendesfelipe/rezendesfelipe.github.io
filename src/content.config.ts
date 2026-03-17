import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
		}),
});
const projects = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    // link do projeto (GitHub, demo, etc.)
    url: z.string().url(),
    // opcional: repo separado do site
    repo: z.string().url().optional(),
    // tags para filtrar/mostrar
    tags: z.array(z.string()).default([]),
    // destacar na home
    featured: z.boolean().default(false),
    // ordenar
    order: z.number().optional(),
  }),
});

export const collections = { blog, projects };
