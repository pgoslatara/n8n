import type { MigrationContext, ReversibleMigration } from '../migration-types';

/**
 * Adds credential:use scope to all existing roles that have credential:read.
 *
 * This migration ensures backward compatibility after splitting credential:read into
 * credential:read (view only) and credential:use (use in workflows).
 * Previously, credential:read allowed both viewing and using credentials.
 * Now, credential:use is required to use credentials in workflows, while credential:read
 * only allows viewing for governance purposes.
 *
 * This migration:
 * 1. Ensures the credential:use scope exists in the scope table
 * 2. Finds all roles (project, credential, and global) with credential:read scope and grants credential:use to them
 *
 * Both system roles (managed by code) and custom roles (user-created) are updated.
 */
export class AddCredentialUseScopeToRoles1768475341537 implements ReversibleMigration {
	async up({ escape, runQuery, logger }: MigrationContext) {
		const scopeTableName = escape.tableName('scope');
		const scopeSlugColumn = escape.columnName('slug');
		const displayNameColumn = escape.columnName('displayName');
		const descriptionColumn = escape.columnName('description');

		const roleTableName = escape.tableName('role');
		const roleScopeTableName = escape.tableName('role_scope');
		const roleSlugColumn = escape.columnName('slug');
		const roleScopeRoleSlugColumn = escape.columnName('roleSlug');
		const roleScopeScopeSlugColumn = escape.columnName('scopeSlug');

		// Step 1: Ensure credential:use scope exists
		const insertScopeQuery = `INSERT INTO ${scopeTableName} (${scopeSlugColumn}, ${displayNameColumn}, ${descriptionColumn})
         VALUES (:slug, :displayName, :description)
         ON CONFLICT (${scopeSlugColumn}) DO NOTHING`;

		await runQuery(insertScopeQuery, {
			slug: 'credential:use',
			displayName: 'Use Credential',
			description: 'Allows using credentials in workflows.',
		});

		logger.debug('Ensured credential:use scope exists');

		// Step 2: Add credential:use to all roles that have credential:read (all role types)
		const batchInsertQuery = `
		INSERT INTO ${roleScopeTableName} (${roleScopeRoleSlugColumn}, ${roleScopeScopeSlugColumn})
		SELECT DISTINCT role.${roleSlugColumn}, :useScope
		FROM ${roleTableName} role
		INNER JOIN ${roleScopeTableName} role_scope
			ON role.${roleSlugColumn} = role_scope.${roleScopeRoleSlugColumn}
		WHERE role_scope.${roleScopeScopeSlugColumn} = :readScope
		ON CONFLICT (${roleScopeRoleSlugColumn}, ${roleScopeScopeSlugColumn}) DO NOTHING
	`;

		await runQuery(batchInsertQuery, {
			readScope: 'credential:read',
			useScope: 'credential:use',
		});

		logger.info('Added credential:use scope to all roles with credential:read');
	}

	async down({ escape, runQuery, logger }: MigrationContext) {
		const roleScopeTableName = escape.tableName('role_scope');
		const roleScopeScopeSlugColumn = escape.columnName('scopeSlug');

		// Remove all credential:use scopes from all roles
		// Since the up migration only adds credential:use to roles with credential:read,
		// all credential:use scopes can be safely removed to revert the migration.
		const deleteQuery = `
			DELETE FROM ${roleScopeTableName}
			WHERE ${roleScopeScopeSlugColumn} = :useScope
		`;

		await runQuery(deleteQuery, {
			useScope: 'credential:use',
		});

		logger.info('Removed credential:use scope from all roles');
	}
}
