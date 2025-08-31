import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
	constructor(
		private readonly usersService: UsersService,
		private readonly jwtService: JwtService,
		private readonly config: ConfigService,
	) {}

	async validateUser(username: string, password: string) {
		const user = await this.usersService.findByUsername(username);
		if (!user) throw new UnauthorizedException('Invalid credentials');
		const match = await bcrypt.compare(password, user.passwordHash);
		if (!match) throw new UnauthorizedException('Invalid credentials');
		return user;
	}

	async login(user: { id: string; username: string; tokenVersion?: number }) {
		const payload = { sub: user.id, username: user.username, tokenVersion: user.tokenVersion ?? 0 } as any;
		const accessExpiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
		const refreshExpiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN') || '30d';
		const access_token = await this.jwtService.signAsync(payload, { expiresIn: accessExpiresIn });
		const refreshPayload = { sub: user.id, tokenVersion: user.tokenVersion ?? 0, jti: await bcrypt.genSalt(6) };
		const refresh_token = await this.jwtService.signAsync(refreshPayload, { expiresIn: refreshExpiresIn });
		// Store refresh token hash
		const hash = await bcrypt.hash(refresh_token, 10);
		const u = await this.usersService.findById(user.id);
		if (u) {
			u.refreshTokenHash = hash;
			await this.usersService.save(u);
		}
		return { access_token, refresh_token };
	}

	async rotateRefresh(userId: string, tokenVersion: number) {
		const accessExpiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN') || '15m';
		const refreshExpiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN') || '30d';
		const user = await this.usersService.findById(userId);
		if (!user) throw new UnauthorizedException('User not found');
		const payload = { sub: user.id, username: user.username, tokenVersion } as any;
		const access_token = await this.jwtService.signAsync(payload, { expiresIn: accessExpiresIn });
		const refreshPayload = { sub: user.id, tokenVersion, jti: await bcrypt.genSalt(6) };
		const refresh_token = await this.jwtService.signAsync(refreshPayload, { expiresIn: refreshExpiresIn });
		user.refreshTokenHash = await bcrypt.hash(refresh_token, 10);
		await this.usersService.save(user);
		return { access_token, refresh_token };
	}
}
