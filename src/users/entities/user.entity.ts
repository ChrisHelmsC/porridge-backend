import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { FileEntity } from '../../files/entities/file.entity';

@Entity('users')
export class UserEntity {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ unique: true })
	email: string;

	@Column()
	passwordHash: string;

	// Refresh token management
	@Column({ type: 'text', nullable: true })
	refreshTokenHash?: string | null;

	@Column({ type: 'int', default: 0 })
	tokenVersion: number;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;

	@OneToMany(() => FileEntity, (file) => file.owner)
	files: FileEntity[];
}
