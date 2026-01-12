import { z } from 'zod';

// Extension point configuration (supports both string and object format)
export const extensionPointConfigSchema = z.union([
	// Simple format: "ComponentName"
	z
		.string()
		.describe('Component name to render at this extension point'),
	// Advanced format: { component: "ComponentName", priority?: number }
	z.object({
		component: z.string().describe('Component name to render'),
		priority: z.number().optional().describe('Rendering priority (higher = first)'),
	}),
]);

// Extension points configuration
// Format: { "views.workflows.headerBefore": "ComponentName" | { component: "ComponentName", priority: 100 } }
export const extensionPointsSchema = z
	.record(
		z.string().describe('Extension point name (e.g., views.workflows.headerBefore)'),
		extensionPointConfigSchema,
	)
	.optional();

// Main manifest schema
export const cloudExtensionManifestSchema = z.object({
	// Identity
	name: z.string(),
	displayName: z.string().optional(),
	description: z.string().optional(),
	version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must be semver format'),

	// Compatibility
	minN8nVersion: z.string().optional(),
	maxN8nVersion: z.string().optional(),

	// Extension points
	extends: extensionPointsSchema.optional(),
});

export type CloudExtensionManifest = z.infer<typeof cloudExtensionManifestSchema>;
export type ExtensionPointConfig = z.infer<typeof extensionPointConfigSchema>;
export type ExtensionPointsConfig = z.infer<typeof extensionPointsSchema>;
