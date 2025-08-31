import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserEntity } from './entities/user.entity';

@Injectable()
export class UsersService {
	constructor(
		@InjectRepository(UserEntity)
		private readonly usersRepo: Repository<UserEntity>,
	) {}

	async createUser(username: string, password: string): Promise<UserEntity> {
		const existing = await this.usersRepo.findOne({ where: { username } });
		if (existing) {
			throw new ConflictException('Username already taken');
		}
		const passwordHash = await bcrypt.hash(password, 10);
		const user = this.usersRepo.create({ username, passwordHash });
		return this.usersRepo.save(user);
	}

	findByUsername(username: string): Promise<UserEntity | null> {
		return this.usersRepo.findOne({ where: { username } });
	}

	findById(id: string): Promise<UserEntity | null> {
		return this.usersRepo.findOne({ where: { id } });
	}

	save(user: UserEntity) {
		return this.usersRepo.save(user);
	}
}
