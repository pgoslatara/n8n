import { readdir, readFile, access } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ManifestValidator } from '@n8n/extension-sdk/validation';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = resolve(__dirname, '../../../extensions');

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function discoverExtensions() {
	const validator = new ManifestValidator();
	const extensions = [];

	try {
		const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const extensionDir = resolve(PLUGINS_DIR, entry.name);
			const manifestPath = resolve(extensionDir, 'n8n.manifest.json');

			try {
				const manifestContent = await readFile(manifestPath, 'utf-8');
				const manifestData = JSON.parse(manifestContent);

				const result = validator.validate(manifestData);

				if (!result.valid) {
					console.error(`❌ Invalid manifest for ${entry.name}:`);
					result.errors.forEach((err) => {
						console.error(`   - ${err.message} (${err.field || 'unknown'})`);
					});
					continue;
				}

				if (result.warnings.length > 0) {
					console.warn(`!  Warnings for ${entry.name}:`);
					result.warnings.forEach((warn) => {
						console.warn(`   - ${warn.message} (${warn.field || 'unknown'})`);
					});
				}

				const resolvedName = `@n8n/extension-${entry.name}`;

				// Check for entry points by file existence (convention over configuration)
				const hasFrontend = await fileExists(resolve(extensionDir, 'src/frontend/index.ts'));
				const hasBackend = await fileExists(resolve(extensionDir, 'src/backend/index.ts'));

				extensions.push({
					name: result.manifest.name,
					resolvedName,
					manifest: result.manifest,
					path: extensionDir,
					manifestPath,
					hasFrontend,
					hasBackend,
				});

				const entries = [
					hasFrontend && 'frontend',
					hasBackend && 'backend',
				].filter(Boolean).join(', ');

				console.log(`✓ Discovered extension: ${resolvedName} [${entries || 'no entries'}]`);
			} catch (error) {
				if (error.code === 'ENOENT') {
					// No manifest file, skip silently
					continue;
				}
				console.error(`❌ Error loading manifest for ${entry.name}:`, error.message);
			}
		}

		return extensions;
	} catch (error) {
		if (error.code === 'ENOENT') {
			console.warn('!  Extensions directory not found, no extensions to discover');
			return [];
		}
		throw error;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	discoverExtensions()
		.then((extensions) => {
			console.log(`\n✓ Discovered ${extensions.length} extension(s)\n`);
		})
		.catch((error) => {
			console.error('❌ Extension discovery failed:', error);
			process.exit(1);
		});
}
