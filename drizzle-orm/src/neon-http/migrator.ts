import type { MigrationConfig } from '~/migrator.ts';
import { readMigrationFiles } from '~/migrator.ts';
import { type SQL, sql } from '~/sql/sql.ts';
import type { NeonHttpDatabase } from './driver.ts';

/**
 * This function reads migrationFolder and execute each unapplied migration and mark it as executed in database
 *
 * NOTE: The Neon HTTP driver does not support transactions. This means that if any part of a migration fails,
 * no rollback will be executed. Currently, you will need to handle unsuccessful migration yourself.
 * @param db - drizzle db instance
 * @param config - path to migration folder generated by drizzle-kit
 */
export async function migrate<TSchema extends Record<string, unknown>>(
	db: NeonHttpDatabase<TSchema>,
	config: string | MigrationConfig,
) {
	const migrationsTable = typeof config === "string"  ? '__drizzle_migrations' : config.migrationsTable ?? '__drizzle_migrations';
	const migrationsSchema = typeof config === "string"  ? 'drizzle' :  config.migrationsSchema ?? 'drizzle';
	const migrations = readMigrationFiles(config);
	const migrationTableCreate = sql`
		CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at bigint
		)
	`;
	await db.session.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
	await db.session.execute(migrationTableCreate);

	const dbMigrations = await db.session.all<{ id: number; hash: string; created_at: string }>(
		sql`select id, hash, created_at from ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} order by created_at desc limit 1`,
	);

	const lastDbMigration = dbMigrations[0];
	const rowsToInsert: SQL[] = [];
	for await (const migration of migrations) {
		if (
			!lastDbMigration
			|| Number(lastDbMigration.created_at) < migration.folderMillis
		) {
			for (const stmt of migration.sql) {
				await db.session.execute(sql.raw(stmt));
			}

			rowsToInsert.push(
				sql`insert into ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} ("hash", "created_at") values(${migration.hash}, ${migration.folderMillis})`,
			);
		}
	}

	for await (const rowToInsert of rowsToInsert) {
		await db.session.execute(rowToInsert);
	}
}
