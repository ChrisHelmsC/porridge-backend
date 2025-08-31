import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

@Entity('files')
export class FileEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  filename: string;

  @Column()
  originalName: string;

  @Column()
  mimeType: string;

  @Column({ type: 'text', nullable: true })
  title?: string | null;

  @Column({ type: 'bigint' })
  size: number;

  @Column()
  url: string;

  @Column({ nullable: true })
  thumbnailUrl?: string;

  @Column({ nullable: true })
  sourceUrl?: string;

  @Column({ type: 'text', array: true, nullable: true })
  tags?: string[];

  @Column()
  hash: string;

  @Column({ type: 'bigint', nullable: true })
  durationMs?: number | null;

  @Column({ type: 'int', nullable: true })
  width?: number | null;

  @Column({ type: 'int', nullable: true })
  height?: number | null;

  @Column({ default: false })
  hasAudio: boolean;

  @Column({ type: 'text', array: true, nullable: true })
  frameHashSequence?: string[] | null;

  @Column({ type: 'text', nullable: true })
  audioFingerprint?: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner?: UserEntity;

  @Column({ type: 'uuid' })
  ownerId?: string;

  @CreateDateColumn()
  uploadedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Transcoding fields
  @Column({ type: 'text', nullable: true })
  mp4Key?: string | null;

  @Column({ type: 'text', nullable: true })
  transcodeStatus?: 'pending' | 'processing' | 'ready' | 'failed' | null;
}
