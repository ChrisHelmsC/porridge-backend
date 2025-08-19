import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

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

  @CreateDateColumn()
  uploadedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
