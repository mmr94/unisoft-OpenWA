import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';

export enum SessionStatus {
  CREATED = 'created',
  INITIALIZING = 'initializing',
  QR_READY = 'qr_ready',
  AUTHENTICATING = 'authenticating',
  READY = 'ready',
  DISCONNECTED = 'disconnected',
  FAILED = 'failed',
  // Engine intentionally unloaded after inactivity to free RAM.
  // The WhatsApp auth data is kept on disk, so resuming does NOT require a new QR scan.
  HIBERNATED = 'hibernated',
}

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  name: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: SessionStatus.CREATED,
  })
  status: SessionStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  pushName: string | null;

  @Column({ type: jsonColumnType(), default: '{}' })
  config: Record<string, unknown>;

  // Phase 3: Proxy per session
  @Column({ type: 'varchar', length: 255, nullable: true })
  proxyUrl: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  proxyType: 'http' | 'https' | 'socks4' | 'socks5' | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  connectedAt: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastActiveAt: Date | null;

  // Timestamp of the last OUTGOING message. Used to detect idle sessions for
  // hibernation. Distinct from lastActiveAt (which also tracks incoming activity).
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastSentAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
