import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `lastSentAt` column to the `sessions` table.
 *
 * This timestamp records the last OUTGOING message per session and is used by
 * the idle-session hibernation checker to decide when a session can be unloaded
 * to free RAM. It is distinct from `lastActiveAt`, which also tracks incoming
 * activity.
 *
 * Uses `TIMESTAMP` on PostgreSQL and `TEXT` on SQLite, matching the existing
 * `lastActiveAt` column convention (see common/utils/column-types.ts).
 *
 * Timestamp 1781050000000 rather than 1781000000000: the latter is already taken by
 * AddBaileysStoredMessages, and two migrations sharing one timestamp are ordered by glob rather
 * than by chain position. Both up() and down() are guarded by hasColumn, so a database that
 * already ran this migration under its previous name simply re-records it and does nothing.
 */
export class AddSessionLastSentAt1781050000000 implements MigrationInterface {
  name = 'AddSessionLastSentAt1781050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.hasTable('sessions');
    if (!tableExists) return;

    const hasColumn = await queryRunner.hasColumn('sessions', 'lastSentAt');
    if (hasColumn) return;

    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const columnType = isPostgres ? 'TIMESTAMP' : 'TEXT';
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "lastSentAt" ${columnType}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tableExists = await queryRunner.hasTable('sessions');
    if (!tableExists) return;

    const hasColumn = await queryRunner.hasColumn('sessions', 'lastSentAt');
    if (!hasColumn) return;

    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "lastSentAt"`);
  }
}
