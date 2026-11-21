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
			lang: z.enum(['pt', 'en']).default('pt'),
			tags: z.array(z.string()).default([]),
			// Extended fields for rich blog structure
			author: z.object({
				name: z.string(),
				role: z.string().optional(),
				url: z.string().url().optional(),
				avatar: z.string().optional(),
			}).optional(),
			category: z.string().optional(),
			readingTime: z.string().optional(),
			draft: z.boolean().default(false),
			canonical: z.string().url().optional(),
		}),
});
const projects = defineCollection({
	loader: glob({ base: './src/content/projects', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		lang: z.enum(['pt', 'en']).default('pt'),
		title: z.string(),
		description: z.string(),
		// link externo do projeto (GitHub, demo, etc.). Sem `page`, o card aponta para cá.
		url: z.string().url().optional(),
		// opcional: repo separado do site
		repo: z.string().url().optional(),
		// tags para filtrar/mostrar
		tags: z.array(z.string()).default([]),
		// destacar na home
		featured: z.boolean().default(false),
		// ordenar
		order: z.number().optional(),
		// Estudo de caso: gera /projetos/<page>/ (pt) ou /en/projects/<page>/ (en).
		// Use o mesmo valor nas duas línguas para o seletor de idioma apontar para a página equivalente.
		page: z.string().regex(/^[a-z0-9-]+$/).optional(),
		subtitle: z.string().optional(),
		pubDate: z.coerce.date().optional(),
		logo: z
			.object({
				src: z.string(),
				alt: z.string(),
				href: z.string().url().optional(),
			})
			.optional(),
		meta: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
		highlights: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
	}),
});
const langSchema = z.enum(['pt', 'en']);

const certifications = defineCollection({
	loader: glob({ base: './src/content/certifications', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    lang: langSchema.default('pt'),
    title: z.string(),
    issuer: z.string(),
    issuedAt: z.coerce.date().optional(),
    url: z.string().url().optional(),
    order: z.number().optional(),
  }),
});
export const collections = { blog, projects, certifications };
